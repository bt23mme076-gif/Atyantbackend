// ─────────────────────────────────────────────────────────────
//  Shared brand layout for every Atyant email.
//  Tokens mirror the frontend's light theme (Atyantfrontend/src/index.css).
// ─────────────────────────────────────────────────────────────

export const B = {
  bg: '#F6F6FB', card: '#FFFFFF', border: '#E3E0EC', soft: '#F2F1F8', footer: '#ECEAF4',
  primary: '#7567C9', primaryText: '#5A4CB0',
  text: '#1B1830', textSub: '#5A5470', textMuted: '#8A8399',
  logo: 'https://www.atyant.in/logo.jpg',
  site: 'https://www.atyant.in',
  body: "-apple-system,'Segoe UI',Roboto,Arial,sans-serif",
  display: "Georgia,'Times New Roman',serif",
};

// Per-feature accent for the header pill and callouts; the CTA stays brand purple everywhere.
export const ACCENT = {
  default: { bg: '#EFECF9', text: '#5A4CB0', border: '#CFC6EE' },
  jobs:    { bg: '#FBF4E8', text: '#9A5B12', border: '#EFD9B4' },
  success: { bg: '#ECF8F0', text: '#15803D', border: '#BFE5CC' },
};

export const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const p = (html) => `<p style="color:${B.textSub};line-height:1.65;margin:0 0 14px;">${html}</p>`;

export const small = (html) => `<p style="color:${B.textMuted};font-size:13px;line-height:1.6;margin:0 0 12px;">${html}</p>`;

export const list = (items, ordered = false) => {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag} style="color:${B.textSub};line-height:1.8;margin:0 0 16px 18px;padding:0;">${items.map(i => `<li>${i}</li>`).join('')}</${tag}>`;
};

// Label/value rows, e.g. session details. Values are trusted HTML — escape before passing.
export const details = (rows) => `
  <table role="presentation" width="100%" style="border-collapse:collapse;background:${B.soft};border-radius:12px;margin:6px 0 18px;">
    ${rows.filter(Boolean).map(([k, v]) => `
      <tr>
        <td style="padding:10px 16px;color:${B.textMuted};font-size:13px;width:38%;vertical-align:top;">${k}</td>
        <td style="padding:10px 16px;color:${B.text};font-size:14px;font-weight:600;">${v}</td>
      </tr>`).join('')}
  </table>`;

// Highlighted box: a quoted question, a tip, a status note.
export const callout = (html, { label, accent = 'default' } = {}) => {
  const a = ACCENT[accent] || ACCENT.default;
  return `
  <div style="background:${a.bg};border:1px solid ${a.border};border-radius:12px;padding:14px 16px;margin:6px 0 18px;">
    ${label ? `<div style="color:${a.text};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">${label}</div>` : ''}
    <div style="color:${B.text};font-size:14px;line-height:1.6;">${html}</div>
  </div>`;
};

export const code = (value) => `
  <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:${B.text};background:${B.soft};border:1px solid ${B.border};border-radius:12px;padding:16px;text-align:center;margin:8px 0 18px;">${esc(value)}</div>`;

export const pills = (items) => `<div style="margin:0 0 16px;">${items.map(i =>
  `<span style="display:inline-block;background:${ACCENT.default.bg};color:${B.primaryText};font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;margin:0 6px 6px 0;">${esc(i)}</span>`).join('')}</div>`;

export const secondaryButton = (label, url) =>
  `<a href="${url}" style="display:inline-block;padding:10px 22px;border:1px solid ${B.border};border-radius:10px;color:${B.primaryText};text-decoration:none;font-weight:600;font-size:14px;background:${B.card};">${label}</a>`;

/**
 * Wrap content in the brand shell.
 *  heading   serif headline
 *  body      html (use p/list/details/callout helpers)
 *  cta       {label, url}, optional
 *  afterCta  html under the button (secondary link, fine print)
 *  tag       header pill text, accent picks its colour
 *  extras    [{title, text, cta, url}] "Also for you" teasers
 *  unsubscribeUrl  marketing mail only; transactional mail shows support contact instead
 */
export function renderLayout({
  heading, body, cta, afterCta = '', tag, accent, extras = [], unsubscribeUrl, signoff = true,
}) {
  const a = ACCENT[accent] || ACCENT.default;
  const alsoBlock = extras.length ? `
    <div style="margin-top:26px;border-top:1px solid ${B.border};padding-top:18px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${B.textMuted};margin-bottom:10px;">Also for you</div>
      ${extras.map(t => `
        <div style="margin-bottom:12px;">
          <a href="${t.url}" style="color:${B.primaryText};font-weight:600;font-size:14px;text-decoration:none;">${t.title} →</a>
          <div style="color:${B.textSub};font-size:13px;margin-top:2px;">${t.text}</div>
        </div>`).join('')}
    </div>` : '';

  const footerRight = unsubscribeUrl
    ? `<a href="${B.site}" style="color:${B.textSub};text-decoration:none;">atyant.in</a> &nbsp;&nbsp;<a href="${unsubscribeUrl}" style="color:${B.textSub};">Unsubscribe</a>`
    : `<a href="${B.site}" style="color:${B.textSub};text-decoration:none;">atyant.in</a> &nbsp;&nbsp;<a href="mailto:support@atyant.in" style="color:${B.textSub};">support@atyant.in</a>`;

  return `
  <div style="background:${B.bg};padding:28px 12px 0;font-family:${B.body};">
    <div style="max-width:600px;margin:0 auto;">
      <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:18px;"><tr>
        <td style="vertical-align:middle;">
          <img src="${B.logo}" width="40" height="40" alt="Atyant" style="display:inline-block;width:40px;height:40px;border-radius:10px;vertical-align:middle;border:0;">
          <span style="font-weight:700;color:${B.text};font-size:16px;margin-left:10px;vertical-align:middle;">Atyant</span>
        </td>
        <td style="text-align:right;vertical-align:middle;">${tag ? `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;">${tag}</span>` : ''}</td>
      </tr></table>

      <div style="background:${B.card};border:1px solid ${B.border};border-radius:16px;padding:36px 40px;font-size:15px;">
        <h1 style="font-family:${B.display};font-weight:400;color:${B.text};font-size:28px;line-height:1.25;margin:0 0 18px;">${heading}</h1>
        ${body}
        ${cta ? `
        <div style="text-align:center;margin:26px 0;">
          <a href="${cta.url}" style="background:${B.primary};color:#ffffff;padding:13px 30px;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;display:inline-block;">${cta.label}</a>
        </div>` : ''}
        ${afterCta}
        ${signoff ? `<p style="color:${B.textSub};line-height:1.6;margin:18px 0 0;">Cheers,<br><strong style="color:${B.text};">Team Atyant</strong></p>` : ''}
        ${alsoBlock}
      </div>
    </div>
    <div style="background:${B.footer};margin:28px -12px 0;padding:18px 12px;">
      <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;border-collapse:collapse;"><tr>
        <td style="font-weight:700;color:${B.text};font-size:14px;">Atyant</td>
        <td style="text-align:right;font-size:12px;color:${B.textSub};">${footerRight}</td>
      </tr></table>
    </div>
  </div>`;
}
