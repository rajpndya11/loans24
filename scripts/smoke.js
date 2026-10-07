// End-to-end smoke test against a running server (local or deployed).
// Covers: OTP login -> address form -> capture -> submit, plus the loan-system API and reviewer decision.
// Usage: npm run smoke            (OTP step needs SMS_PROVIDER=console / ALLOW_CONSOLE_OTP=true)
import sharp from 'sharp';
import assert from 'node:assert/strict';

const base = process.env.SMOKE_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
const key = process.env.INTERNAL_API_KEY;
let cookie = '';

async function call(path, { token, apiKey, method = 'GET', json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = key;
  if (cookie) headers.cookie = cookie;
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : form });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Textured, well-lit image so it passes sharpness/brightness; seed makes each one unique.
async function testPhoto(seed, { dark = false } = {}) {
  const w = 800, h = 1000;
  const px = Buffer.alloc(w * h * 3);
  let x = seed * 7919;
  for (let i = 0; i < px.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; px[i] = dark ? x % 20 : 60 + (x % 140); }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}

function captureForm(kind, buf, mime, at) {
  const f = new FormData();
  f.append('kind', kind);
  if (at) { f.append('lat', at.lat); f.append('lng', at.lng); f.append('accuracy', 12); }
  f.append('clientTs', new Date().toISOString());
  f.append('file', new Blob([buf], { type: mime }), kind === 'photo' ? 'p.jpg' : 'pan.webm');
  return f;
}

const tokenOf = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('t');

async function captureAndSubmit(token, { at, pan }) {
  assert.equal((await call('/api/v/consent', { token, method: 'POST', json: { accepted: true, lang: 'hi' } })).status, 200);
  const dark = await call('/api/v/captures', { token, method: 'POST', form: captureForm('photo', await testPhoto(9, { dark: true }), 'image/jpeg', at) });
  assert.equal(dark.body.hint, 'TOO_DARK');
  for (let i = 0; i < 3; i++) {
    const r = await call('/api/v/captures', { token, method: 'POST', form: captureForm('photo', await testPhoto(Math.floor(Math.random() * 1e9)), 'image/jpeg', at) });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  if (pan) {
    assert.equal((await call('/api/v/submit', { token, method: 'POST' })).status, 400, 'submit without pan must fail');
    assert.equal((await call('/api/v/captures', { token, method: 'POST', form: captureForm('pan', Buffer.from('fake'), 'video/webm;codecs=vp8', at) })).body.ok, true);
  }
  const sub = await call('/api/v/submit', { token, method: 'POST' });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((await call('/api/v/submit', { token, method: 'POST' })).status, 409, 'double submit must fail');
  return sub.body.decision;
}

// ---- 1. Customer: login with OTP ----
assert.equal((await call('/api/me')).status, 401);
assert.equal((await call('/api/auth/otp', { method: 'POST', json: { phone: '12345' } })).status, 400);
const otp = await call('/api/auth/otp', { method: 'POST', json: { phone: '+91 98765 43210' } });
assert.equal(otp.status, 200, JSON.stringify(otp.body));
assert.ok(otp.body.devCode, 'devCode missing: set SMS_PROVIDER=console (or ALLOW_CONSOLE_OTP=true) for the smoke test');
const wrong = await call('/api/auth/verify', { method: 'POST', json: { phone: '9876543210', code: otp.body.devCode === '000000' ? '111111' : '000000' } });
assert.equal(wrong.status, 400);
assert.equal((await call('/api/auth/verify', { method: 'POST', json: { phone: '9876543210', code: otp.body.devCode } })).status, 200);
assert.equal((await call('/api/me')).status, 200);
console.log('login         : OK');

// ---- 2. Customer: address form (no lat/lng anywhere) -> capture -> submit ----
const address = { line1: 'Cubbon Park', area: 'Sampangi Rama Nagar', city: 'Bengaluru', pincode: '560001' };
const check = await call('/api/me/address-check', { method: 'POST', json: address });
assert.equal(check.status, 200);
console.log(`address-check : found=${check.body.found} ${check.body.label ?? ''}`);
const bad = await call('/api/me/verifications', { method: 'POST', json: { ...address, placeType: 'home', fullName: '', pincode: '12' } });
assert.deepEqual(Object.keys(bad.body.errors).sort(), ['fullName', 'pincode']);
const created = await call('/api/me/verifications', { method: 'POST', json: { ...address, placeType: 'homeoffice', fullName: 'Smoke Tester', lang: 'hi', assist: true } });
assert.equal(created.status, 201, JSON.stringify(created.body));
const sid = created.body.id;
const declared = (await call(`/api/internal/sessions/${sid}`, { apiKey: true })).body.session;
const at = declared.declared_lat != null ? { lat: declared.declared_lat + 0.0002, lng: declared.declared_lng } : { lat: 12.97, lng: 77.59 };
const d1 = await captureAndSubmit(tokenOf(created.body.link), { at, pan: false });
console.log(`self-serve    : decision=${d1}`);
const mine = await call('/api/me/verifications');
assert.equal(mine.body[0].id, sid);

// ---- 3. Loan-system API with address parts + reviewer decision ----
const sys = await call('/api/internal/sessions', {
  apiKey: true, method: 'POST',
  json: { loanId: `SMOKE-${Date.now()}`, applicantName: 'Smoke Test', ...address, declaredLat: 12.9716, declaredLng: 77.5946, persona: 'salaried', lang: 'en' },
});
assert.equal(sys.status, 201, JSON.stringify(sys.body));
const d2 = await captureAndSubmit(tokenOf(sys.body.link), { at: { lat: 12.9916, lng: 77.5946 }, pan: true }); // ~2 km away
assert.equal(d2, 'review');
assert.equal((await call(`/api/internal/sessions/${sys.body.sessionId}/decision`, { apiKey: true, method: 'POST', json: { decision: 'rejected', reviewer: 'smoke' } })).status, 400);
assert.equal((await call(`/api/internal/sessions/${sys.body.sessionId}/decision`, { apiKey: true, method: 'POST', json: { decision: 'agent_visit', reviewer: 'smoke', note: 'far from address' } })).status, 200);
console.log(`loan-system   : decision=${d2} -> reviewer sent agent`);

assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 200);
console.log('SMOKE OK');
