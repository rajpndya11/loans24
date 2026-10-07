// Notifies the loan origination system of final outcomes. Body is signed with HMAC-SHA256
// (header X-Signature: sha256=<hex>) so the receiver can verify origin.
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { config } from './config.js';
import { logEvent } from './db.js';

export function sessionResultPayload(s) {
  return {
    event: 'verification.completed',
    sessionId: s.id,
    loanId: s.loan_id,
    status: s.status,
    score: s.score,
    reasons: s.reasons ? JSON.parse(s.reasons).map((r) => r.code) : [],
    decidedBy: s.decided_by,
    decidedAt: s.decided_at,
  };
}

async function deliver(session) {
  const body = JSON.stringify(sessionResultPayload(session));
  const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      await logEvent(session.id, res.ok ? 'webhook.delivered' : 'webhook.failed', 'system', { status: res.status, attempt });
      if (res.ok) return;
    } catch (err) {
      await logEvent(session.id, 'webhook.failed', 'system', { error: err.message, attempt });
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  // Production: push to a dead-letter queue / alert instead of giving up.
  console.error(`[webhook] giving up for session ${session.id}`);
}

/** Fire-and-forget that survives the response on serverless (Vercel waitUntil). */
export function notify(session) {
  if (!config.webhookUrl || !session) return;
  const p = deliver(session).catch((e) => console.error('[webhook]', e));
  try { waitUntil(p); } catch { /* not on Vercel: the process stays alive anyway */ }
}
