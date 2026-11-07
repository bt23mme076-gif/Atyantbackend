// WhatsApp Cloud API sender. WA_API_BASE defaults to Meta's Graph API; point it
// at the BSP's Cloud-API-compatible base if messages go through GetGabs.
const base = () => (process.env.WA_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');

export const isConfigured = () => !!(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A dropped send = a student staring at a silent chat, so transient failures
// (network blips, Meta 429/5xx) retry twice with backoff before giving up.
async function post(body, attempt = 0) {
  if (!isConfigured()) {
    console.warn('⚠️ WhatsApp not configured — message dropped');
    return null;
  }
  let res;
  try {
    res = await fetch(`${base()}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (attempt < 2) { await sleep(700 * (attempt + 1)); return post(body, attempt + 1); }
    console.error(`WhatsApp send failed (network): ${err.message}`);
    return null;
  }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(700 * (attempt + 1));
      return post(body, attempt + 1);
    }
    const text = await res.text().catch(() => '');
    console.error(`WhatsApp send failed (${res.status}): ${text.slice(0, 300)}`);
    return null;
  }
  return res.json().catch(() => null);
}

const send = (to, payload) => post({ recipient_type: 'individual', to, ...payload });

// Blue ticks + "typing…" under the business name until our reply lands (max ~25 s).
export const showTyping = (messageId) =>
  post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }).catch(() => null);

export const sendText = (to, text) =>
  send(to, { type: 'text', text: { body: clip(text, 4096), preview_url: true } });

// link: public URL of a 512×512 WebP (static ≤100 KB, animated ≤500 KB).
export const sendSticker = (to, link) => send(to, { type: 'sticker', sticker: { link } });

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
