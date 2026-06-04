// ─────────────────────────────────────────────────────────────────────────────
//  shareLinks.js — Mentor profile sharing toolkit
//
//  Builds everything a mentor needs to share their Atyant profile on external
//  platforms (LinkedIn, WhatsApp, X/Twitter, Telegram, Facebook, Email) so more
//  students discover them and join the platform.
// ─────────────────────────────────────────────────────────────────────────────

// Where mentor profiles are rendered on the frontend (e.g. https://atyant.in/profile/<username>)
const frontendBase = () =>
  (process.env.FRONTEND_URL || 'https://atyant.in').replace(/\/+$/, '');

// Where the backend lives (used for the tracked redirect link mentors post publicly)
const backendBase = () =>
  (process.env.BACKEND_URL || process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');

// Frontend path under which a profile page is served. Override with PROFILE_PATH.
const profilePath = () =>
  (process.env.PROFILE_PATH || '/profile').replace(/\/+$/, '');

/** Public profile URL on the frontend. */
export function buildProfileUrl(username, { via } = {}) {
  const url = `${frontendBase()}${profilePath()}/${encodeURIComponent(username)}`;
  const params = new URLSearchParams({ ref: 'share' });
  if (via) params.set('via', via);
  return `${url}?${params.toString()}`;
}

/**
 * Tracked referral URL that mentors post on social media.
 * Hits the backend, increments the click counter, then redirects to the profile.
 * Falls back to the direct frontend URL if no public backend base is configured.
 */
export function buildTrackedUrl(username, { via } = {}) {
  const base = backendBase();
  if (!base) return buildProfileUrl(username, { via });
  const url = `${base}/api/share/r/${encodeURIComponent(username)}`;
  return via ? `${url}?via=${encodeURIComponent(via)}` : url;
}

/** A short, ready-to-post message a mentor can use as a caption. */
export function buildShareText(user) {
  const company =
    Array.isArray(user.topCompanies) && user.topCompanies.length
      ? user.topCompanies[0]
      : null;
  const headline = company
    ? `I'm mentoring on Atyant — ask me how I cracked ${company}.`
    : `I'm mentoring students on Atyant. Book a session or ask me anything.`;
  return `${headline} Connect with me here 👇`;
}

/**
 * Build the full share kit: the canonical URLs plus per-platform deep links that
 * pre-fill the share dialog of each social network.
 */
export function buildShareKit(user) {
  const username = user.username;
  const profileUrl = buildProfileUrl(username);
  const text = buildShareText(user);

  // Each platform gets its own tracked link so we can see which channel converts.
  const link = (via) => buildTrackedUrl(username, { via });

  const enc = encodeURIComponent;
  const titleText = enc(text);

  const platforms = {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(link('linkedin'))}`,
    twitter: `https://twitter.com/intent/tweet?text=${titleText}&url=${enc(link('twitter'))}`,
    whatsapp: `https://wa.me/?text=${enc(`${text} ${link('whatsapp')}`)}`,
    telegram: `https://t.me/share/url?url=${enc(link('telegram'))}&text=${titleText}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(link('facebook'))}`,
    email: `mailto:?subject=${enc('Connect with me on Atyant')}&body=${enc(`${text}\n\n${link('email')}`)}`,
  };

  return {
    username,
    profileUrl,                 // direct frontend link
    trackedUrl: link('copy'),   // tracked link for "copy link" button
    shareText: text,
    // Open Graph metadata the frontend can use for rich previews.
    meta: {
      title: `${user.name || username} on Atyant`,
      description: user.bio || buildShareText(user),
      image: user.profilePicture || user.picture || null,
    },
    platforms,
  };
}
