// Customer login: mobile OTP -> signed, HttpOnly cookie. Stateless, so it works across serverless instances.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one } from './db.js';

const COOKIE = 'l24_session';

const hmac = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const otpHash = (phone, code) => hmac(`otp:${phone}:${code}`);

/** Accepts "98765 43210", "+91 9876543210", "09876543210"; returns 10 digits or null. */
export function normalisePhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export const maskPhone = (p) => `${p.slice(0, 2)}xxxxxx${p.slice(-2)}`;

export function setLoginCookie(req, res, userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + config.loginDays * 86400_000 })).toString('base64url');
  const value = `${payload}.${hmac(payload)}`;
  const secure = req.secure || config.publicBaseUrl.startsWith('https://');
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.loginDays * 86400}${secure ? '; Secure' : ''}`);
}

export function clearLoginCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCookie(req) {
  const raw = (req.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export async function currentUser(req) {
  const c = readCookie(req);
  return c ? one('SELECT * FROM users WHERE id = $1', [c.uid]) : null;
}

export async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    req.user = user;
    next();
  } catch (err) { next(err); }
}
