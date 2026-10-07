// Local / self-hosted server: API + static pages from public/ + daily retention timer.
// On Vercel this file is not used: public/ is served by the CDN and the API runs from api/index.js.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';
import { config } from './config.js';
import { runRetention } from './retention.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = express();
server.use(app);
server.use(express.static(path.join(root, 'public'), { extensions: ['html'], maxAge: '5m' }));
server.use((req, res) => res.status(404).sendFile(path.join(root, 'public', '404.html')));

server.listen(config.port, () => {
  console.log(`Loans24 verification running at ${config.publicBaseUrl}`);
  console.log(`  Home: ${config.publicBaseUrl}/   Review console: ${config.publicBaseUrl}/admin/`);
  const run = () => runRetention().catch((e) => console.error('[retention]', e));
  run();
  setInterval(run, 6 * 3600_000).unref();
});
