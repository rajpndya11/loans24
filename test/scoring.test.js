import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../server/scoring.js';
import { haversineM } from '../server/checks/geo.js';
import { nameMatchScore } from '../server/checks/ocr.js';
import { laplacianVariance, hammingHex, judgeQuality } from '../server/checks/quality.js';

const cfg = {
  geofenceRadiusM: 150, maxGpsAccuracyM: 100, maxCaptureSpreadM: 60, maxClockSkewMin: 10,
  acceptThreshold: 80, maxRetakes: 2, nameUncheckedPenalty: 10,
};
const HOME = { lat: 19.0760, lng: 72.8777 };
const ts = '2026-10-07T10:00:00.000Z';
const photo = (dLat = 0, accuracy = 15) => ({ lat: HOME.lat + dLat, lng: HOME.lng, accuracy_m: accuracy, client_ts: ts, server_ts: ts });
const session = (attempt = 1) => ({ declared_lat: HOME.lat, declared_lng: HOME.lng, attempt });
const base = { duplicateOf: [], nameMatch: { ran: true, score: 1 } };

test('haversine is roughly right', () => {
  // 0.001 deg latitude ~ 111 m
  assert.ok(Math.abs(haversineM(HOME.lat, HOME.lng, HOME.lat + 0.001, HOME.lng) - 111) < 2);
});

test('clean capture at declared address auto-accepts', () => {
  const r = evaluate({ ...base, session: session(), photos: [photo(), photo(0.0001), photo()] }, cfg);
  assert.equal(r.decision, 'accepted');
  assert.equal(r.score, 100);
});

test('capture far from declared address goes to review, never retake/reject', () => {
  const r = evaluate({ ...base, session: session(), photos: [photo(0.02), photo(0.02), photo(0.02)] }, cfg);
  assert.equal(r.decision, 'review');
  assert.ok(r.reasons.some((x) => x.code === 'GEO_OUTSIDE'));
  assert.deepEqual(r.hints, []); // no geofence hints leak to the customer
});

test('unreadable nameplate triggers retake while retries remain, then review', () => {
  const input = { ...base, nameMatch: { ran: true, score: 0 }, photos: [photo(0, 150), photo(0, 150), photo(0, 150)] };
  const first = evaluate({ ...input, session: session(1) }, cfg);
  assert.equal(first.decision, 'retake');
  assert.ok(first.hints.includes('NAME_NOT_FOUND'));
  const last = evaluate({ ...input, session: session(3) }, cfg);
  assert.equal(last.decision, 'review');
});

test('area-level address match widens the fence instead of failing', () => {
  const s = { ...session(), geo_precision: 'area' };
  const r = evaluate({ ...base, session: s, photos: [photo(0.004), photo(0.004), photo(0.004)] }, cfg); // ~450 m
  assert.equal(r.decision, 'accepted');
  assert.ok(r.reasons.some((x) => x.code === 'GEO_APPROX'));
  assert.ok(!r.reasons.some((x) => x.code.startsWith('GEO_OUT')));
});

test('duplicate image is a hard flag regardless of score', () => {
  const r = evaluate({ ...base, duplicateOf: ['x'], session: session(), photos: [photo(), photo(), photo()] }, cfg);
  assert.equal(r.decision, 'review');
});

test('missing declared coordinates cannot auto-accept', () => {
  const r = evaluate({ ...base, session: { declared_lat: null, declared_lng: null, attempt: 1 }, photos: [photo(), photo(), photo()] }, cfg);
  assert.equal(r.decision, 'review');
});

test('name matching tolerates order, case and one typo', () => {
  assert.equal(nameMatchScore('Ramesh Kumar Sharma', 'SHARMA\nR. K. Sharma Kumar Ramesh'), 1);
  assert.equal(nameMatchScore('Sri Lakshmi Traders', 'SRI LAKSHMI TRADER'), 1);
  assert.equal(nameMatchScore('Ramesh Sharma', 'Flat 402'), 0);
});

test('laplacian variance: flat image is 0, checkerboard is high', () => {
  const w = 20, h = 20;
  const flat = new Uint8Array(w * h).fill(128);
  const checker = Uint8Array.from({ length: w * h }, (_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 255 : 0));
  assert.equal(laplacianVariance(flat, w, h), 0);
  assert.ok(laplacianVariance(checker, w, h) > 1000);
});

test('quality judgement and hamming distance', () => {
  const q = { minSharpness: 40, minBrightness: 45, maxBrightness: 225 };
  assert.equal(judgeQuality({ sharpness: 100, brightness: 120 }, q).ok, true);
  assert.equal(judgeQuality({ sharpness: 10, brightness: 120 }, q).hint, 'BLURRY');
  assert.equal(judgeQuality({ sharpness: 100, brightness: 20 }, q).hint, 'TOO_DARK');
  assert.equal(hammingHex('ffffffffffffffff', 'fffffffffffffff0'), 4);
});
