// The API as an Express app. Used by Vercel (api/index.js) and by the local server (server/local.js).
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { config, configProblems } from './config.js';
import { customer } from './routes/customer.js';
import { internal } from './routes/internal.js';
import { account } from './routes/account.js';
import { runRetention } from './retention.js';
import { safeEqual } from './auth.js';

// Don't crash on bad setup: report exactly which settings are missing (names only, never values).
const setupProblems = configProblems();
if (setupProblems.length) console.error('[setup] Missing configuration:\n - ' + setupProblems.join('\n - '));

export const CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': config.env === 'production' ? [] : null,
};

export const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: CSP }, referrerPolicy: { policy: 'no-referrer' } }));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=()');
  next();
});

const limiter = (limit) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false });

app.get('/api/healthz', (req, res) => {
  res.status(setupProblems.length ? 503 : 200).json({ ok: !setupProblems.length, problems: setupProblems });
});

app.use('/api', (req, res, next) => (setupProblems.length
  ? res.status(503).json({ error: 'SETUP_INCOMPLETE', problems: setupProblems })
  : next()));

app.get('/api/cron/retention', async (req, res, next) => {
  const bearer = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (!config.cronSecret || !safeEqual(bearer, config.cronSecret)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try { res.json(await runRetention()); } catch (err) { next(err); }
});

app.use('/api/v', limiter(60), express.json({ limit: '10kb' }), customer);
app.use('/api/internal', limiter(300), express.json({ limit: '50kb' }), internal);
app.use('/api/auth', limiter(10));
app.use('/api', limiter(60), express.json({ limit: '20kb' }), account);

app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON' });
  console.error(err);
  // Database unreachable / wrong credentials / wrong database name.
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '28P01', '28000', '3D000'].includes(err.code)) {
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
  }
  res.status(500).json({ error: 'INTERNAL' });
});
