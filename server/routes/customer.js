// API used by the capture app. Auth = bearer token from the verification link.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, one, now, logEvent } from '../db.js';
import { putFile } from '../storage.js';
import { analysePhoto, judgeQuality } from '../checks/quality.js';
import {
  LANGS, OPEN_STATUSES, sessionByToken, panRequired, progress, submitSession, newId, getSession,
} from '../sessions.js';
import { notify } from '../webhook.js';

export const customer = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(config.maxPhotoBytes, config.maxVideoBytes), files: 1, fields: 10 },
});

const MAX_PHOTOS_PER_ATTEMPT = 15;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

customer.use(wrap(async (req, res, next) => {
  const m = (req.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{30,100})$/);
  const s = m && await sessionByToken(m[1]);
  if (!s || s.purged_at) return res.status(401).json({ error: 'INVALID_LINK' });
  if (OPEN_STATUSES.has(s.status) && Date.parse(s.expires_at) < Date.now()) {
    await query(`UPDATE sessions SET status = 'expired' WHERE id = $1`, [s.id]);
    await logEvent(s.id, 'session.expired', 'system');
    return res.status(410).json({ error: 'LINK_EXPIRED' });
  }
  if (s.status === 'expired') return res.status(410).json({ error: 'LINK_EXPIRED' });
  req.s = s;
  next();
}));

function requireStatus(...allowed) {
  return (req, res, next) => (allowed.includes(req.s.status)
    ? next()
    : res.status(409).json({ error: 'WRONG_STATE', status: req.s.status }));
}

async function view(s) {
  return {
    status: s.status,
    lang: s.lang,
    persona: s.persona,
    assist: s.persona === 'lowdigital' || s.assist === 1,
    firstName: s.applicant_name.split(/\s+/)[0],
    address: s.address_text,
    attempt: s.attempt,
    maxRetakes: config.maxRetakes,
    photosRequired: config.photosRequired,
    panRequired: panRequired(s),
    consentVersion: config.consentVersion,
    retentionDays: config.retentionDays,
    progress: await progress(s),
  };
}

const coord = (v, lim) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
};

customer.get('/session', wrap(async (req, res) => res.json(await view(req.s))));

customer.post('/consent', requireStatus('created'), wrap(async (req, res) => {
  if (req.body?.accepted !== true) return res.status(400).json({ error: 'CONSENT_REQUIRED' });
  const lang = LANGS.includes(req.body.lang) ? req.body.lang : req.s.lang;
  await query(`UPDATE sessions SET status = 'consented', consent_at = $1, consent_version = $2, lang = $3 WHERE id = $4`,
    [now(), config.consentVersion, lang, req.s.id]);
  await logEvent(req.s.id, 'consent.given', 'customer',
    { version: config.consentVersion, lang, userAgent: req.get('user-agent') }, req.ip);
  res.json(await view(await getSession(req.s.id)));
}));

customer.post('/captures', requireStatus('consented'), upload.single('file'), wrap(async (req, res) => {
  const s = req.s;
  const kind = req.body.kind;
  const file = req.file;
  if (!file || !['photo', 'pan'].includes(kind)) return res.status(400).json({ error: 'BAD_REQUEST' });

  const base = {
    id: newId(),
    lat: coord(req.body.lat, 90),
    lng: coord(req.body.lng, 180),
    accuracy: coord(req.body.accuracy, 1e6),
    clientTs: Number.isFinite(Date.parse(req.body.clientTs)) ? new Date(req.body.clientTs).toISOString() : null,
  };
  const insert = (vals) => query(`INSERT INTO captures (id, session_id, kind, attempt, file_key, mime, bytes, sha256, phash,
      lat, lng, accuracy_m, client_ts, server_ts, quality, quality_ok)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, vals);

  if (kind === 'photo') {
    if (file.size > config.maxPhotoBytes) return res.status(413).json({ error: 'FILE_TOO_LARGE' });
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM captures WHERE session_id = $1 AND attempt = $2 AND kind = 'photo'`,
      [s.id, s.attempt]);
    if (n >= MAX_PHOTOS_PER_ATTEMPT) return res.status(429).json({ error: 'TOO_MANY_CAPTURES' });

    let a;
    try { a = await analysePhoto(file.buffer); } catch { return res.status(400).json({ error: 'INVALID_IMAGE' }); }
    const q = judgeQuality(a, config.quality);
    const key = await putFile(`${s.id}/${s.attempt}/${base.id}.jpg`, a.normalised, 'image/jpeg');
    await insert([base.id, s.id, 'photo', s.attempt, key, 'image/jpeg', a.normalised.length,
      crypto.createHash('sha256').update(a.normalised).digest('hex'), a.phash,
      base.lat, base.lng, base.accuracy, base.clientTs, now(), JSON.stringify(q), q.ok ? 1 : 0]);
    await logEvent(s.id, 'capture.photo', 'customer', { id: base.id, ok: q.ok, hint: q.hint }, req.ip);
    return res.json({ id: base.id, ok: q.ok, hint: q.hint, progress: await progress(s) });
  }

  // Pan video: stored for reviewer playback; not machine-scored yet.
  const mime = (file.mimetype || '').split(';')[0];
  if (!['video/webm', 'video/mp4', 'video/quicktime'].includes(mime)) return res.status(400).json({ error: 'INVALID_VIDEO' });
  if (file.size > config.maxVideoBytes) return res.status(413).json({ error: 'FILE_TOO_LARGE' });
  const ext = mime === 'video/webm' ? 'webm' : 'mp4';
  const key = await putFile(`${s.id}/${s.attempt}/${base.id}.${ext}`, file.buffer, mime);
  await insert([base.id, s.id, 'pan', s.attempt, key, mime, file.size,
    crypto.createHash('sha256').update(file.buffer).digest('hex'), null,
    base.lat, base.lng, base.accuracy, base.clientTs, now(), null, 1]);
  await logEvent(s.id, 'capture.pan', 'customer', { id: base.id, bytes: file.size }, req.ip);
  res.json({ id: base.id, ok: true, progress: await progress(s) });
}));

customer.post('/submit', requireStatus('consented'), wrap(async (req, res) => {
  const r = await submitSession(req.s, req.ip);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r, session: await view(await getSession(req.s.id)) });
}));

// Recovery path: customer can't / won't self-capture -> schedule a field agent instead of a dead end.
customer.post('/fallback', requireStatus('created', 'consented'), wrap(async (req, res) => {
  const reason = String(req.body?.reason || 'unspecified').slice(0, 60);
  await query(`UPDATE sessions SET status = 'agent_visit', decided_by = 'customer', decided_at = $1 WHERE id = $2`,
    [now(), req.s.id]);
  await logEvent(req.s.id, 'fallback.agent_visit', 'customer', { reason }, req.ip);
  const s = await getSession(req.s.id);
  notify(s);
  res.json(await view(s));
}));

customer.post('/feedback', wrap(async (req, res) => {
  const ces = Number(req.body?.ces);
  if (!Number.isInteger(ces) || ces < 1 || ces > 5) return res.status(400).json({ error: 'BAD_REQUEST' });
  await query('UPDATE sessions SET ces = $1 WHERE id = $2', [ces, req.s.id]);
  await logEvent(req.s.id, 'feedback.ces', 'customer', { ces });
  res.json({ ok: true });
}));
