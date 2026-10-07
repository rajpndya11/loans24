// Expires stale links and purges personal data after the retention window (DPDP Act: storage limitation).
// Runs daily via Vercel Cron (/api/cron/retention) or a timer when self-hosted.
// The audit events table is kept; it holds no images or address/name data.
import { query, now, logEvent } from './db.js';
import { config } from './config.js';
import { deletePrefix } from './storage.js';

export async function runRetention() {
  const ts = now();
  const expired = await query(`UPDATE sessions SET status = 'expired'
      WHERE status IN ('created', 'consented') AND expires_at < $1 RETURNING id`, [ts]);

  const cutoff = new Date(Date.now() - config.retentionDays * 86400_000).toISOString();
  const due = await query(`SELECT id FROM sessions WHERE purged_at IS NULL AND created_at < $1
      AND status NOT IN ('processing', 'review') LIMIT 500`, [cutoff]);
  for (const { id } of due) {
    await deletePrefix(id);
    await query('DELETE FROM captures WHERE session_id = $1', [id]);
    await query(`UPDATE sessions SET applicant_name = '[purged]', business_name = NULL, address_text = '[purged]',
        declared_lat = NULL, declared_lng = NULL, geocode_label = NULL, purged_at = $1 WHERE id = $2`, [ts, id]);
    await logEvent(id, 'data.purged', 'system', { retentionDays: config.retentionDays });
  }
  await query('DELETE FROM otps WHERE expires_at < $1', [new Date(Date.now() - 86400_000).toISOString()]);
  return { expired: expired.length, purged: due.length };
}
