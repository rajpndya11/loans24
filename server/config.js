const env = process.env;

function num(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be a number, got "${v}"`);
  return n;
}

const port = num('PORT', 8080);
const onVercel = Boolean(env.VERCEL);
const defaultBaseUrl = env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
  : `http://localhost:${port}`;

export const config = {
  env: env.NODE_ENV || 'development',
  onVercel,
  port,
  // Base URL customers open. Must be HTTPS in production (camera + GPS require a secure context).
  publicBaseUrl: (env.PUBLIC_BASE_URL || defaultBaseUrl).replace(/\/$/, ''),
  // Shared secret for the internal API (loan system -> this service) and the review console.
  internalApiKey: env.INTERNAL_API_KEY || '',
  // Signs customer login cookies.
  sessionSecret: env.SESSION_SECRET || '',
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  cronSecret: env.CRON_SECRET || '',
  trustProxy: env.TRUST_PROXY === 'true' || onVercel,

  // Storage: Postgres if DATABASE_URL is set, else an embedded Postgres (PGlite) under DATA_DIR.
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  // Files: Vercel Blob if the token is set, else local disk under DATA_DIR.
  blobToken: env.BLOB_READ_WRITE_TOKEN || '',
  dataDir: env.DATA_DIR || './data',

  sessionTtlHours: num('SESSION_TTL_HOURS', 72),
  loginDays: num('LOGIN_DAYS', 7),
  retentionDays: num('RETENTION_DAYS', 90),
  consentVersion: env.CONSENT_VERSION || '2026-10-v1',

  // Capture requirements. Vercel functions accept max 4.5 MB per request.
  photosRequired: num('PHOTOS_REQUIRED', 3),
  maxRetakes: num('MAX_RETAKES', 2),
  maxPhotoBytes: num('MAX_PHOTO_BYTES', 4 * 1024 * 1024),
  maxVideoBytes: num('MAX_VIDEO_BYTES', 4 * 1024 * 1024),

  // Image quality thresholds. Calibrate these on real captures before go-live.
  quality: {
    minSharpness: num('QUALITY_MIN_SHARPNESS', 40), // Laplacian variance at 640px width
    minBrightness: num('QUALITY_MIN_BRIGHTNESS', 45), // mean luma 0-255
    maxBrightness: num('QUALITY_MAX_BRIGHTNESS', 225),
  },

  // Geo
  geofenceRadiusM: num('GEOFENCE_RADIUS_M', 150),
  maxGpsAccuracyM: num('MAX_GPS_ACCURACY_M', 100),
  maxCaptureSpreadM: num('MAX_CAPTURE_SPREAD_M', 60),
  maxClockSkewMin: num('MAX_CLOCK_SKEW_MIN', 10),

  // Decisioning
  acceptThreshold: num('ACCEPT_THRESHOLD', 80),
  duplicateHammingMax: num('DUPLICATE_HAMMING_MAX', 6),

  // Address -> map location: nominatim (free, low volume) | google | none
  geocoder: env.GEOCODER || (env.GOOGLE_MAPS_API_KEY ? 'google' : 'nominatim'),
  googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '',
  nominatimEmail: env.NOMINATIM_EMAIL || '',

  // Nameplate/signage OCR: none | google-vision
  ocrProvider: env.OCR_PROVIDER || 'none',
  googleVisionApiKey: env.GOOGLE_VISION_API_KEY || '',

  // Login OTP delivery: console (dev only — OTP shown on screen) | msg91 | twilio
  smsProvider: env.SMS_PROVIDER || 'console',
  msg91AuthKey: env.MSG91_AUTH_KEY || '',
  msg91TemplateId: env.MSG91_TEMPLATE_ID || '',
  twilioSid: env.TWILIO_ACCOUNT_SID || '',
  twilioToken: env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: env.TWILIO_FROM || '',

  // Outbound result webhook to the loan origination system
  webhookUrl: env.WEBHOOK_URL || '',
  webhookSecret: env.WEBHOOK_SECRET || '',
};

export const isProd = config.env === 'production';

/** Setup problems as plain-English messages naming the env var (never its value). */
export function configProblems() {
  const problems = [];
  if (config.internalApiKey.length < 24) problems.push('INTERNAL_API_KEY is missing (needs 24+ random characters)');
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET is missing (needs 32+ random characters)');
  if (config.onVercel || isProd) {
    if (!config.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL must start with https://');
    if (!config.databaseUrl) problems.push('DATABASE_URL is missing (Vercel → Storage → connect Neon Postgres)');
    if (config.onVercel && !config.blobToken) problems.push('BLOB_READ_WRITE_TOKEN is missing (Vercel → Storage → connect Blob)');
    if (config.smsProvider === 'msg91' && (!config.msg91AuthKey || !config.msg91TemplateId)) problems.push('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID are missing');
    if (config.smsProvider === 'twilio' && (!config.twilioSid || !config.twilioToken || !config.twilioFrom)) problems.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are missing');
    if (config.webhookUrl && !config.webhookSecret) problems.push('WEBHOOK_SECRET is missing (required when WEBHOOK_URL is set)');
  }
  return problems;
}

export function assertConfig() {
  const problems = configProblems();
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
}

// Demo login: no SMS provider configured -> no SMS is sent and the code is shown on screen.
// Anyone can log in as any number in this mode: use it for demos/reviews only, never with real customers.
export const demoMode = () => config.smsProvider === 'console';
export const showDevOtp = demoMode;
