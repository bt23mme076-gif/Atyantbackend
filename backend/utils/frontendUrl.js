// ─────────────────────────────────────────────────────────────────────────────
//  Frontend URL resolution
//
//  Meet links (and other deep links) are absolute URLs, but the DB is shared
//  across environments. A session created on production stores an atyant.in link;
//  when viewed on localhost it must still open locally. These helpers centralize
//  how we pick the frontend base and let us re-point a stored link at whatever
//  environment is currently serving the request.
// ─────────────────────────────────────────────────────────────────────────────

// Base URL of the frontend for the current environment.
// Non-production prefers LOCAL_FRONTEND_URL so links open on localhost.
// Trailing slashes are stripped to avoid the `//session/...` double-slash bug.
export function frontendBase() {
  const base = (process.env.NODE_ENV !== 'production' && process.env.LOCAL_FRONTEND_URL)
    ? process.env.LOCAL_FRONTEND_URL
    : (process.env.FRONTEND_URL || 'http://localhost:5173');
  return base.replace(/\/+$/, '');
}

// Path prefix under which atyant.in now proxies the product app. atyant.in used
// to proxy bare "/" to the product app, but that changed: "/" is now the
// marketing site's own homepage, and the product app moved to "/atyantEngine"
// (and everything under it). Overridable via PRODUCT_APP_PATH; empty string
// restores the old bare-root behaviour (e.g. atyantproduct.vercel.app directly,
// where the product app IS the root — no prefix needed there).
const PRODUCT_APP_PATH = (process.env.PRODUCT_APP_PATH ?? '/atyantEngine').replace(/\/+$/, '');

// Absolute in-app meet link for a session id, built for the current environment.
// Served at the root with a ?meet= query param because the marketing site
// (atyant.in) only proxies "/" to the product app — a /session/meet/<id> path
// would fall through to the marketing site. Root + query keeps it same-origin
// so the user's localStorage auth token is available on the meet page.
export function meetLinkFor(sessionId) {
  return `${frontendBase()}${PRODUCT_APP_PATH}/?meet=${sessionId}`;
}

// Absolute in-app CHAT deep link, built for the current environment.
// Served at the root with a ?chat=<partnerId> query param for the same reason
// meet links use ?meet= — the marketing site only proxies "/" to the product
// app, and root + query keeps it same-origin so the localStorage auth token is
// available. `partnerId` is the OTHER person in the thread (mentor opens the
// student's thread, student opens the mentor's thread).
export function chatLinkFor(partnerId) {
  return `${frontendBase()}${PRODUCT_APP_PATH}/?chat=${partnerId}`;
}

// Re-point a stored (possibly cross-environment) meet link at the current
// frontend base. Handles both the new ?meet=<id> form and the legacy
// /session/meet/<id> path. Returns the input unchanged if it isn't a meet link.
export function localizeMeetLink(meetingLink) {
  if (!meetingLink) return meetingLink;
  const q = meetingLink.match(/[?&]meet=([^&#]+)/);
  if (q) return `${frontendBase()}${PRODUCT_APP_PATH}/?meet=${q[1]}`;
  const m = meetingLink.match(/\/session\/meet\/([^/?#]+)/);
  if (m) return `${frontendBase()}${PRODUCT_APP_PATH}/?meet=${m[1]}`;
  return meetingLink;
}
