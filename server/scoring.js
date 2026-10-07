// Pure, auditable decision function. Every point deducted carries a reason code.
// Customers are never auto-rejected: outcomes are accepted | retake | review.
import { haversineM, median, maxSpreadM } from './checks/geo.js';

const RETAKEABLE = new Set(['GPS_LOW_ACCURACY', 'NAME_NOT_FOUND', 'NAME_PARTIAL', 'GPS_MISSING']);
const HARD_FLAGS = new Set(['DUPLICATE_IMAGE']);

/**
 * @param {object} input
 * @param {{declared_lat:number|null, declared_lng:number|null, attempt:number}} input.session
 * @param {Array<{lat:number|null,lng:number|null,accuracy_m:number|null,client_ts:string|null,server_ts:string}>} input.photos  quality-passed photos of the current attempt
 * @param {string[]} input.duplicateOf  capture ids in OTHER sessions with near-identical images
 * @param {{ran:boolean, score:number}} input.nameMatch  0..1
 * @param {object} cfg  config subset
 */
export function evaluate({ session, photos, duplicateOf, nameMatch }, cfg) {
  const reasons = [];
  const add = (code, penalty, detail) => reasons.push({ code, penalty, detail });

  // ---- Geo ----
  const located = photos.filter((p) => p.lat != null && p.lng != null);
  if (!located.length) {
    add('GPS_MISSING', 40, 'No capture carried a GPS fix');
  } else {
    const accuracy = median(located.map((p) => p.accuracy_m ?? Infinity));
    if (accuracy > cfg.maxGpsAccuracyM) add('GPS_LOW_ACCURACY', 15, `Median accuracy ${Math.round(accuracy)}m`);

    const spread = maxSpreadM(located);
    if (spread > cfg.maxCaptureSpreadM) add('GPS_INCONSISTENT', 15, `Captures ${Math.round(spread)}m apart`);

    if (session.declared_lat == null || session.declared_lng == null) {
      add('GEO_UNVERIFIED', 30, 'Declared address could not be found on the map');
    } else {
      // When the address only resolved to its locality/pincode, widen the fence and note it.
      const approx = session.geo_precision === 'area';
      const radius = cfg.geofenceRadiusM * (approx ? 4 : 1);
      if (approx) add('GEO_APPROX', 10, 'Address matched to locality level only');
      const dist = median(located.map((p) => haversineM(p.lat, p.lng, session.declared_lat, session.declared_lng)));
      if (dist > radius * 3) add('GEO_OUTSIDE', 50, `${Math.round(dist)}m from declared address`);
      else if (dist > radius) add('GEO_NEAR', 15, `${Math.round(dist)}m from declared address`);
    }
  }

  // ---- Device clock vs server clock (stale or replayed captures) ----
  const skewed = photos.filter((p) => p.client_ts &&
    Math.abs(Date.parse(p.client_ts) - Date.parse(p.server_ts)) > cfg.maxClockSkewMin * 60_000);
  if (skewed.length) add('CLOCK_SKEW', 10, `${skewed.length} capture(s) with device clock skew`);

  // ---- Nameplate / signage ----
  if (!nameMatch.ran) add('NAME_NOT_CHECKED', cfg.nameUncheckedPenalty ?? 10, 'OCR provider not configured');
  else if (nameMatch.score === 0) add('NAME_NOT_FOUND', 30, 'Name not readable on nameplate/signage');
  else if (nameMatch.score < 0.5) add('NAME_PARTIAL', 15, `Name match ${Math.round(nameMatch.score * 100)}%`);

  // ---- Fraud ----
  if (duplicateOf.length) add('DUPLICATE_IMAGE', 60, `Matches ${duplicateOf.length} capture(s) from other applications`);

  const score = Math.max(0, 100 - reasons.reduce((s, r) => s + r.penalty, 0));
  const codes = reasons.map((r) => r.code);

  let decision;
  if (codes.some((c) => HARD_FLAGS.has(c))) decision = 'review';
  else if (score >= cfg.acceptThreshold) decision = 'accepted';
  else if (codes.some((c) => RETAKEABLE.has(c)) && session.attempt <= cfg.maxRetakes) decision = 'retake';
  else decision = 'review';

  // Only safe, actionable hints go back to the customer (never geofence/fraud details).
  const hints = decision === 'retake' ? codes.filter((c) => RETAKEABLE.has(c)) : [];

  return { decision, score, reasons, hints };
}
