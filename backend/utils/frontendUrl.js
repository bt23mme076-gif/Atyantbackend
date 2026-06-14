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

// Absolute in-app meet link for a session id, built for the current environment.
export function meetLinkFor(sessionId) {
  return `${frontendBase()}/session/meet/${sessionId}`;
}

// Re-point a stored (possibly cross-environment) meet link at the current
// frontend base, preserving the /session/meet/<id> path. Returns the input
// unchanged if it doesn't look like a meet link.
export function localizeMeetLink(meetingLink) {
  if (!meetingLink) return meetingLink;
  const m = meetingLink.match(/\/session\/meet\/[^/?#]+/);
  if (!m) return meetingLink;
  return `${frontendBase()}${m[0]}`;
}
