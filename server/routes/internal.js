// Internal API: loan system creates sessions; review console reads and decides.
// Auth = X-API-Key. Production: put the review console behind company SSO and use per-reviewer identity.
import express from 'express';
import { config } from '../config.js';
import { query, one, now, logEvent } from '../db.js';
import { getFile } from '../storage.js';
import { safeEqual } from '../auth.js';
import { haversineM } from '../checks/geo.js';
import { createSession, getSession, buildAddress, PERSONAS, LANGS } from '../sessions.js';
import { notify } from '../webhook.js';

export const internal = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

internal.use((req, res, next) => {
  if (!safeEqual(req.get('x-api-key') || '', config.internalApiKey)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
});

const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * Address can be sent either as parts { line1, area, city, pincode } (preferred — it is looked up on the
 * map automatically) or as addressText. declaredLat/declaredLng are optional overrides.
 */
internal.post('/sessions', wrap(async (req, res) => {
  const b = req.body || {};
  const parts = { line1: str(b.line1, 200), area: str(b.area, 120), city: str(b.city, 80), pincode: str(b.pincode, 6) };
  const input = {
    loanId: str(b.loanId, 64),
    applicantName: str(b.applicantName, 120),
    businessName: b.businessName ? str(b.businessName, 160) : null,
    addressText: str(b.addressText, 400) || (parts.line1 && parts.city ? buildAddress(parts) : null),
    addressParts: parts,
    declaredLat: typeof b.declaredLat === 'number' ? b.declaredLat : null,
    declaredLng: typeof b.declaredLng === 'number' ? b.declaredLng : null,
    persona: PERSONAS.includes(b.persona) ? b.persona : null,
    assist: b.assist === true,
    lang: LANGS.includes(b.lang) ? b.lang : 'en',
  };
  const errors = [];
  if (!input.loanId) errors.push('loanId');
  if (!input.applicantName) errors.push('applicantName');
  if (!input.addressText) errors.push('address (line1 + city, or addressText)');
  if (parts.pincode && !/^[1-9]\d{5}$/.test(parts.pincode)) errors.push('pincode (6 digits)');
  if (!input.persona) errors.push(`persona (one of ${PERSONAS.join(', ')})`);
  if ((input.declaredLat === null) !== (input.declaredLng === null)
    || (input.declaredLat !== null && (Math.abs(input.declaredLat) > 90 || Math.abs(input.declaredLng) > 180))) {
    errors.push('declaredLat/declaredLng (optional; both numbers or both omitted)');
  }
  if (errors.length) return res.status(400).json({ error: 'VALIDATION', fields: errors });
  res.status(201).json(await createSession(input));
}));

internal.get('/sessions', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await query(`SELECT id, loan_id, applicant_name, persona, status, score, attempt, created_at, submitted_at, decided_at
      FROM sessions ${status ? 'WHERE status = $2' : ''} ORDER BY created_at DESC LIMIT $1`,
  status ? [limit, status] : [limit]);
  res.json(rows);
}));

internal.get('/sessions/:id', wrap(async (req, res) => {
  const s = await getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const { token_hash, ...safe } = s;
  const hasHome = s.declared_lat != null;
  const captures = await query(`SELECT id, kind, attempt, mime, bytes, lat, lng, accuracy_m, client_ts, server_ts, quality, quality_ok
      FROM captures WHERE session_id = $1 ORDER BY server_ts`, [s.id]);
  const events = await query('SELECT type, actor, data, at FROM events WHERE session_id = $1 ORDER BY id', [s.id]);
  res.json({
    session: { ...safe, reasons: s.reasons ? JSON.parse(s.reasons) : [] },
    captures: captures.map((c) => ({
      ...c,
      quality: c.quality ? JSON.parse(c.quality) : null,
      // Reviewers see "how far from the declared address", not raw coordinates.
      distanceM: hasHome && c.lat != null ? Math.round(haversineM(c.lat, c.lng, s.declared_lat, s.declared_lng)) : null,
    })),
    events: events.map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null })),
  });
}));

internal.get('/captures/:id/file', wrap(async (req, res) => {
  const c = await one('SELECT session_id, file_key, mime FROM captures WHERE id = $1', [req.params.id]);
  if (!c) return res.status(404).end();
  await logEvent(c.session_id, 'capture.viewed', 'reviewer', { captureId: req.params.id }, req.ip);
  res.type(c.mime).set('cache-control', 'no-store').send(await getFile(c.file_key));
}));

const DECISIONS = ['accepted', 'rejected', 'agent_visit'];

internal.post('/sessions/:id/decision', wrap(async (req, res) => {
  const s = await getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  if (s.status !== 'review') return res.status(409).json({ error: 'WRONG_STATE', status: s.status });
  const decision = req.body?.decision;
  const reviewer = str(req.body?.reviewer, 80);
  const note = req.body?.note ? String(req.body.note).slice(0, 1000) : null;
  if (!DECISIONS.includes(decision) || !reviewer) return res.status(400).json({ error: 'VALIDATION' });
  if (decision === 'rejected' && !note) return res.status(400).json({ error: 'NOTE_REQUIRED_FOR_REJECTION' });

  await query(`UPDATE sessions SET status = $1, decided_by = $2, decided_at = $3, review_note = $4 WHERE id = $5`,
    [decision, `reviewer:${reviewer}`, now(), note, s.id]);
  await logEvent(s.id, `review.${decision}`, `reviewer:${reviewer}`, { note }, req.ip);
  notify(await getSession(s.id));
  res.json({ ok: true });
}));
