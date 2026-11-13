// Operational alerts (out of credits, a voice down). Always logged with an
// [ALERT] marker; also POSTed to OPS_ALERT_WEBHOOK (e.g. an n8n webhook) when
// set. The same kind alerts at most once every 15 minutes per process.
const QUIET_MS = 15 * 60 * 1000;
const lastSent = new Map();

export function alertOps(kind, message) {
  const now = Date.now();
  if (lastSent.get(kind) > now - QUIET_MS) return;
  lastSent.set(kind, now);
  console.error(`[ALERT] ${kind}: ${message}`);
  const url = process.env.OPS_ALERT_WEBHOOK;
  if (!url) return;
  fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ kind, message, at: new Date(now).toISOString() }),
    signal : AbortSignal.timeout(10000)
  }).catch(err => console.error(`[ALERT] could not post ${kind} to OPS_ALERT_WEBHOOK: ${err.message}`));
}
