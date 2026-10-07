import crypto from 'node:crypto';
import { query, one, now, logEvent } from './db.js';
import { config } from './config.js';
import { getFile } from './storage.js';
import { evaluate } from './scoring.js';
import { hammingHex } from './checks/quality.js';
import { extractText, nameMatchScore } from './checks/ocr.js';
import { geocode } from './checks/geocode.js';
import { notify } from './webhook.js';

export const PERSONAS = ['salaried', 'business', 'wfh', 'lowdigital'];
export const LANGS = ['en', 'hi', 'mr', 'ta', 'te'];
// Statuses in which the customer can still act on the link.
export const OPEN_STATUSES = new Set(['created', 'consented']);

export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('base64url');
// Token lives in the URL fragment so it never reaches server/proxy access logs or Referer headers.
const linkFor = (token) => `${config.publicBaseUrl}/v/#t=${token}`;

export function buildAddress({ line1, area, city, pincode }) {
  return [line1, area, city, pincode].filter(Boolean).join(', ');
}

/**
 * input: { loanId, applicantName, businessName, addressText, addressParts?, declaredLat?, declaredLng?,
 *          persona, assist?, lang, userId? }
 * If no coordinates are given, the address is looked up on the map automatically.
 */
export async function createSession(input) {
  let geo = null;
  if (input.declaredLat != null && input.declaredLng != null) {
    geo = { lat: input.declaredLat, lng: input.declaredLng, label: null, precision: 'exact' };
  } else {
    const p = input.addressParts || {};
    geo = await geocode({ full: input.addressText, area: p.area, city: p.city, pincode: p.pincode });
  }

  const token = newToken();
  const id = newId();
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionTtlHours * 3600_000);
  await query(`INSERT INTO sessions (id, token_hash, user_id, loan_id, applicant_name, business_name, address_text,
      declared_lat, declared_lng, geocode_label, geo_precision, persona, assist, lang, status, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'created', $15, $16)`,
  [id, sha256(token), input.userId ?? null, input.loanId, input.applicantName, input.businessName ?? null,
    input.addressText, geo?.lat ?? null, geo?.lng ?? null, geo?.label ?? null, geo?.precision ?? null,
    input.persona, input.assist ? 1 : 0, input.lang, created.toISOString(), expires.toISOString()]);
  await logEvent(id, 'session.created', input.userId ? 'customer' : 'internal-api',
    { loanId: input.loanId, persona: input.persona, geocoded: Boolean(geo), precision: geo?.precision ?? null });

  return {
    sessionId: id,
    link: linkFor(token),
    expiresAt: expires.toISOString(),
    location: geo ? { found: true, label: geo.label, precision: geo.precision } : { found: false },
  };
}

/** Issues a fresh link (old one stops working). Used when a logged-in customer resumes. */
export async function rotateLink(sessionId) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
  await query('UPDATE sessions SET token_hash = $1, expires_at = $2 WHERE id = $3', [sha256(token), expires, sessionId]);
  await logEvent(sessionId, 'link.rotated', 'customer');
  return linkFor(token);
}

export const getSession = (id) => one('SELECT * FROM sessions WHERE id = $1', [id]);
export const sessionByToken = (token) => one('SELECT * FROM sessions WHERE token_hash = $1', [sha256(token)]);

export function panRequired(session) {
  return session.persona !== 'wfh'; // dignity-first: WFH customers capture entrance + nameplate only
}

export async function progress(session) {
  const row = await one(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'photo' AND quality_ok = 1 THEN 1 ELSE 0 END), 0)::int AS photos,
      COALESCE(SUM(CASE WHEN kind = 'pan' THEN 1 ELSE 0 END), 0)::int AS pans
    FROM captures WHERE session_id = $1 AND attempt = $2`, [session.id, session.attempt]);
  return { photosOk: row.photos, panDone: row.pans > 0 };
}

async function findDuplicates(session, photos) {
  const matches = new Set();
  const others = await query(`SELECT id, phash, sha256 FROM captures
      WHERE kind = 'photo' AND phash IS NOT NULL AND session_id <> $1`, [session.id]);
  // O(n) scan is fine for an MVP; move to a BK-tree / vector index beyond ~1M captures.
  for (const p of photos) {
    for (const o of others) {
      if (o.sha256 === p.sha256 || hammingHex(o.phash, p.phash) <= config.duplicateHammingMax) matches.add(o.id);
    }
  }
  return [...matches];
}

async function runNameMatch(session, photos) {
  if (config.ocrProvider === 'none') return { ran: false, score: 0 };
  const expected = session.persona === 'business' && session.business_name ? session.business_name : session.applicant_name;
  let best = 0;
  for (const p of photos) {
    const text = await extractText(await getFile(p.file_key));
    best = Math.max(best, nameMatchScore(expected, text));
    if (best >= 0.5) break;
  }
  return { ran: true, score: best };
}

export async function submitSession(session, ip) {
  const photos = await query(`SELECT * FROM captures WHERE session_id = $1 AND attempt = $2 AND kind = 'photo' AND quality_ok = 1
      ORDER BY server_ts`, [session.id, session.attempt]);
  const p = await progress(session);
  if (p.photosOk < config.photosRequired || (panRequired(session) && !p.panDone)) {
    return { error: 'INCOMPLETE', status: 400 };
  }

  // Lock against double-submit.
  const locked = await query(`UPDATE sessions SET status = 'processing', submitted_at = $1
      WHERE id = $2 AND status = 'consented' RETURNING id`, [now(), session.id]);
  if (locked.length !== 1) return { error: 'ALREADY_SUBMITTED', status: 409 };
  await logEvent(session.id, 'session.submitted', 'customer', { attempt: session.attempt }, ip);

  try {
    const result = evaluate({
      session,
      photos,
      duplicateOf: await findDuplicates(session, photos),
      nameMatch: await runNameMatch(session, photos),
    }, config);

    const reasons = JSON.stringify(result.reasons);
    if (result.decision === 'retake') {
      await query(`UPDATE sessions SET status = 'consented', attempt = attempt + 1, score = $1, reasons = $2 WHERE id = $3`,
        [result.score, reasons, session.id]);
    } else if (result.decision === 'accepted') {
      await query(`UPDATE sessions SET status = 'accepted', score = $1, reasons = $2, decided_by = 'auto', decided_at = $3 WHERE id = $4`,
        [result.score, reasons, now(), session.id]);
    } else {
      await query(`UPDATE sessions SET status = 'review', score = $1, reasons = $2 WHERE id = $3`,
        [result.score, reasons, session.id]);
    }
    await logEvent(session.id, `decision.${result.decision}`, 'system', { score: result.score, reasons: result.reasons });

    if (result.decision === 'accepted') notify(await getSession(session.id));
    return { decision: result.decision, hints: result.hints };
  } catch (err) {
    await query(`UPDATE sessions SET status = 'consented' WHERE id = $1`, [session.id]);
    await logEvent(session.id, 'decision.error', 'system', { error: err.message });
    throw err;
  }
}
