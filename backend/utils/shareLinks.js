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

// Default preview image used when a user has no avatar, or when their avatar is
// hosted somewhere social crawlers can't reliably fetch (e.g. Google avatars,
// which LinkedIn's bot frequently gets a 403 on). Override with OG_DEFAULT_IMAGE.
const DEFAULT_OG_IMAGE = () =>
  process.env.OG_DEFAULT_IMAGE || `${frontendBase()}/og-default.png`;

// Hosts whose images crawlers (esp. LinkedIn) tend to block — fall back instead.
const UNFETCHABLE_IMAGE = /googleusercontent\.com|fbcdn\.net|lookaside\.|cdn\.discordapp/i;

/** Resolve a user's avatar to an absolute https URL a crawler can fetch, or a safe default. */
export function buildOgImage(user) {
  const raw = (user && (user.profilePicture || user.picture)) || '';
  if (!raw || UNFETCHABLE_IMAGE.test(raw)) return DEFAULT_OG_IMAGE();
  if (/^https?:\/\//i.test(raw)) return raw;
  // Relative path → make absolute against the frontend.
  return `${frontendBase()}/${String(raw).replace(/^\/+/, '')}`;
}

/** Public profile URL on the frontend. */
export function buildProfileUrl(username, { via } = {}) {
  const url = `${frontendBase()}${profilePath()}/${encodeURIComponent(username)}`;
  const params = new URLSearchParams({ ref: 'share' });
  if (via) params.set('via', via);
  return `${url}?${params.toString()}`;
}

/**
 * Where a clicked share link should actually land the visitor.
 * The frontend has no per-mentor profile route yet (/profile/:username 404s on
 * Vercel), so by default we send people to the home page. Once a real profile
 * page exists, set SHARE_LANDING=profile to deep-link to it instead.
 */
export function buildLandingUrl(username, { via } = {}) {
  return buildProfileUrl(username, { via });

  
}

/**
 * Tracked referral URL that mentors post on social media.
 * Hits the backend, increments the click counter, then redirects to the profile.
 * Falls back to the direct frontend URL if no public backend base is configured.
 */
export function buildTrackedUrl(username, { via } = {}) {
  return buildProfileUrl(username, { via });
  
}

/** A short, ready-to-post message a mentor can use as a caption. */
export function buildShareText(user) {
  const company =
    Array.isArray(user.topCompanies) && user.topCompanies.length
      ? user.topCompanies[0]
      : null;

  const edu =
    Array.isArray(user.education) && user.education.length ? user.education[0] : null;
  const school = edu ? (edu.institutionName || edu.institution || null) : null;
  const field = edu ? (edu.field || null) : null;
  const from = [school, field].filter(Boolean).join(' ').trim();

  if (company && from) {
    return `I've shared my exact path from ${from} → ${company} on Atyant — verified answers for students walking the same journey. Ask me anything or book a session. 👇`;
  }
  if (company) {
    return `I've shared my exact path from ${company} on Atyant — verified answers for students walking the same journey. Ask me anything or book a session. 👇`;
  }
  if (from) {
    return `I've shared my exact path from ${from} on Atyant — verified answers for students walking the same journey. Ask me anything or book a session. 👇`;
  }
  return `I'm mentoring students on Atyant — verified answers for students walking the same journey. Ask me anything or book a session. 👇`;
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
      // The share caption is what we want to surface on the unfurled card.
      description: buildShareText(user),
      image: buildOgImage(user),
    },
    platforms,
  };
}
