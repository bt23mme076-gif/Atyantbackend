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

// Returns true when the FRONTEND_URL points at the production domain (atyant.in)
// where the React app is mounted at the /atyantEngine sub-path.
// We intentionally check the *configured FRONTEND_URL* rather than NODE_ENV
// because the server may run with NODE_ENV=development even on the live VPS.
function isProductionDomain() {
  const url = process.env.FRONTEND_URL || '';
  return url.includes('atyant.in');
}

// Absolute in-app meet link for a session id, built for the current environment.
// Served at the root with a ?meet= query param because the marketing site
// (atyant.in) only proxies "/" to the product app — a /session/meet/<id> path
// would fall through to the marketing site. Root + query keeps it same-origin
// so the user's localStorage auth token is available on the meet page.
export function meetLinkFor(sessionId) {
  const suffix = isProductionDomain() ? '/atyantEngine' : '';
  return `${frontendBase()}${suffix}/?meet=${sessionId}`;
}

// Re-point a stored (possibly cross-environment) meet link at the current
// frontend base. Handles both the new ?meet=<id> form and the legacy
// /session/meet/<id> path. Returns the input unchanged if it isn't a meet link.
export function localizeMeetLink(meetingLink) {
  if (!meetingLink) return meetingLink;
  const suffix = isProductionDomain() ? '/atyantEngine' : '';
  const q = meetingLink.match(/[?&]meet=([^&#]+)/);
  if (q) return `${frontendBase()}${suffix}/?meet=${q[1]}`;
  const m = meetingLink.match(/\/session\/meet\/([^/?#]+)/);
  if (m) return `${frontendBase()}${suffix}/?meet=${m[1]}`;
  return meetingLink;
}
