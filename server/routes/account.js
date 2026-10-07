// Customer accounts: OTP login + "my verifications".
import express from 'express';
import crypto from 'node:crypto';
import { showDevOtp, demoMode } from '../config.js';
import { query, one, now } from '../db.js';
import {
  otpHash, safeEqual, normalisePhone, maskPhone, setLoginCookie, clearLoginCookie, requireUser,
} from '../auth.js';
import { sendOtp } from '../sms.js';
import { geocode } from '../checks/geocode.js';
import { createSession, rotateLink, buildAddress, LANGS, OPEN_STATUSES, newId } from '../sessions.js';

export const account = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const OTP_TTL_MS = 5 * 60_000;
const RESEND_AFTER_MS = 30_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

/* ---------- Login ---------- */
account.get('/auth/config', (req, res) => res.json({ demo: demoMode() }));

account.post('/auth/otp', wrap(async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'INVALID_PHONE' });

  const existing = await one('SELECT * FROM otps WHERE phone = $1', [phone]);
  const t = Date.now();
  if (existing && t - Date.parse(existing.last_sent_at) < RESEND_AFTER_MS) {
    return res.status(429).json({ error: 'WAIT', retryAfter: Math.ceil((RESEND_AFTER_MS - (t - Date.parse(existing.last_sent_at))) / 1000) });
  }
  const windowFresh = existing && t - Date.parse(existing.window_start) < 3600_000;
  if (windowFresh && existing.sent_count >= MAX_SENDS_PER_HOUR) return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const ts = now();
  await query(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_count, window_start, last_sent_at)
      VALUES ($1, $2, $3, 0, $4, $5, $6)
      ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
        sent_count = EXCLUDED.sent_count, window_start = EXCLUDED.window_start, last_sent_at = EXCLUDED.last_sent_at`,
  [phone, otpHash(phone, code), new Date(t + OTP_TTL_MS).toISOString(),
    windowFresh ? existing.sent_count + 1 : 1, windowFresh ? existing.window_start : ts, ts]);

  await sendOtp(phone, code);
  res.json({ ok: true, phone: maskPhone(phone), ...(showDevOtp() ? { devCode: code } : {}) });
}));

account.post('/auth/verify', wrap(async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  const code = String(req.body?.code ?? '').trim();
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'OTP_INVALID' });

  const row = await one('SELECT * FROM otps WHERE phone = $1', [phone]);
  if (!row || Date.parse(row.expires_at) < Date.now()) return res.status(400).json({ error: 'OTP_EXPIRED' });
  if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  if (!safeEqual(row.code_hash, otpHash(phone, code))) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE phone = $1', [phone]);
    return res.status(400).json({ error: 'OTP_INVALID', attemptsLeft: MAX_ATTEMPTS - row.attempts - 1 });
  }
  await query('DELETE FROM otps WHERE phone = $1', [phone]);

  const ts = now();
  const user = await one(`INSERT INTO users (id, phone, created_at, last_login_at) VALUES ($1, $2, $3, $3)
      ON CONFLICT (phone) DO UPDATE SET last_login_at = EXCLUDED.last_login_at RETURNING *`, [newId(), phone, ts]);
  setLoginCookie(req, res, user.id);
  res.json({ user: { name: user.name, phone: maskPhone(user.phone) } });
}));

account.post('/auth/logout', (req, res) => {
  clearLoginCookie(res);
  res.json({ ok: true });
});

/* ---------- Me ---------- */
account.get('/me', requireUser, (req, res) => {
  res.json({ user: { name: req.user.name, phone: maskPhone(req.user.phone) } });
});

account.get('/me/verifications', requireUser, wrap(async (req, res) => {
  const rows = await query(`SELECT id, status, persona, business_name, address_text, created_at, expires_at, decided_at
      FROM sessions WHERE user_id = $1 AND purged_at IS NULL ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  res.json(rows.map((r) => ({
    id: r.id,
    status: r.status,
    placeType: r.persona,
    businessName: r.business_name,
    address: r.address_text,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    canContinue: OPEN_STATUSES.has(r.status),
  })));
}));

const PLACE_TYPES = { home: 'salaried', shop: 'business', homeoffice: 'wfh' };
const clean = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

function readForm(b = {}) {
  return {
    fullName: clean(b.fullName, 120),
    placeType: PLACE_TYPES[b.placeType],
    businessName: clean(b.businessName, 160),
    line1: clean(b.line1, 200),
    area: clean(b.area, 120),
    city: clean(b.city, 80),
    pincode: clean(b.pincode, 6),
    lang: LANGS.includes(b.lang) ? b.lang : 'en',
    assist: b.assist === true,
    loanRef: clean(b.loanRef, 64),
  };
}

function validate(f, { addressOnly = false } = {}) {
  const errors = {};
  if (!addressOnly) {
    if (f.fullName.length < 2) errors.fullName = 'Please enter your full name';
    if (!f.placeType) errors.placeType = 'Please choose what you are verifying';
    if (f.placeType === 'business' && !f.businessName) errors.businessName = 'Please enter your shop or business name';
  }
  if (f.line1.length < 3) errors.line1 = 'Please enter your house / flat / shop number and building';
  if (f.area.length < 2) errors.area = 'Please enter your area or locality';
  if (f.city.length < 2) errors.city = 'Please enter your city';
  if (!/^[1-9]\d{5}$/.test(f.pincode)) errors.pincode = 'Pincode must be 6 digits';
  return errors;
}

// Shows the customer where we found their address before they start (no coordinates shown).
account.post('/me/address-check', requireUser, wrap(async (req, res) => {
  const f = readForm(req.body);
  const errors = validate(f, { addressOnly: true });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION', errors });
  const geo = await geocode({ full: buildAddress(f), area: f.area, city: f.city, pincode: f.pincode });
  res.json(geo ? { found: true, label: geo.label, precision: geo.precision } : { found: false });
}));

account.post('/me/verifications', requireUser, wrap(async (req, res) => {
  const f = readForm(req.body);
  const errors = validate(f);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION', errors });

  if (!req.user.name) await query('UPDATE users SET name = $1 WHERE id = $2', [f.fullName, req.user.id]);

  const r = await createSession({
    userId: req.user.id,
    loanId: f.loanRef || `SELF-${Date.now().toString(36).toUpperCase()}`,
    applicantName: f.fullName,
    businessName: f.businessName || null,
    addressText: buildAddress(f),
    addressParts: { area: f.area, city: f.city, pincode: f.pincode },
    persona: f.placeType,
    assist: f.assist,
    lang: f.lang,
  });
  res.status(201).json({ id: r.sessionId, link: r.link, location: r.location });
}));

account.post('/me/verifications/:id/continue', requireUser, wrap(async (req, res) => {
  const s = await one('SELECT id, status, user_id FROM sessions WHERE id = $1', [req.params.id]);
  if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!OPEN_STATUSES.has(s.status)) return res.status(409).json({ error: 'WRONG_STATE', status: s.status });
  res.json({ link: await rotateLink(s.id) });
}));
