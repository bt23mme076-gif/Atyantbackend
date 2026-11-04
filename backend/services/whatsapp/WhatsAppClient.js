// WhatsApp Cloud API sender. WA_API_BASE defaults to Meta's Graph API; point it
// at the BSP's Cloud-API-compatible base if messages go through GetGabs.
const base = () => (process.env.WA_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');

export const isConfigured = () => !!(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

async function send(to, payload) {
  if (!isConfigured()) {
    console.warn('⚠️ WhatsApp not configured — message dropped');
    return null;
  }
  const res = await fetch(`${base()}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`);
    return null;
  }
  return res.json().catch(() => null);
}

export const sendText = (to, text) =>
  send(to, { type: 'text', text: { body: clip(text, 4096), preview_url: true } });

// buttons: [{ id, title }] — max 3, title ≤ 20 chars
export const sendButtons = (to, text, buttons) =>
  send(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(text, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })),
      },
    },
  });

// rows: [{ id, title, description? }] — max 10, title ≤ 24 chars
export const sendList = (to, text, buttonLabel, rows) =>
  send(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(text, 1024) },
      action: {
        button: clip(buttonLabel, 20),
        sections: [{
          title: 'Options',
          rows: rows.slice(0, 10).map(r => ({
            id: clip(r.id, 200),
            title: clip(r.title, 24),
            ...(r.description ? { description: clip(r.description, 72) } : {}),
          })),
        }],
      },
    },
  });
