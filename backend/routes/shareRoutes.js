// ─────────────────────────────────────────────────────────────────────────────
//  shareRoutes.js — Mentor profile sharing & referral tracking
//
//   GET  /api/share/me            (auth)   — share kit for the logged-in mentor
//   GET  /api/share/u/:username   (public) — share kit for any public profile
//   POST /api/share/me/track      (auth)   — record that the mentor shared
//   GET  /api/share/r/:username   (public) — tracked redirect link to post publicly
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import { buildShareKit, buildLandingUrl } from '../utils/shareLinks.js';

const router = express.Router();

// Platforms we attribute referral clicks to (anything else is bucketed as "other").
const KNOWN_SOURCES = new Set([
  'linkedin', 'twitter', 'whatsapp', 'telegram', 'facebook', 'email', 'copy',
]);
const normalizeSource = (v) => {
  const s = String(v || '').toLowerCase().trim();
  return KNOWN_SOURCES.has(s) ? s : 'other';
};

// GET /api/share/me — share kit for the logged-in mentor
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('username name bio topCompanies profilePicture picture profileShares referralClicks referralSignups referralBySource')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.username) {
      return res.status(400).json({ message: 'Set a username before sharing your profile.' });
    }

    res.json({
      success: true,
      share: buildShareKit(user),
      stats: {
        profileShares: user.profileShares || 0,
        referralClicks: user.referralClicks || 0,
        referralSignups: user.referralSignups || 0,
        referralBySource: user.referralBySource || {},
      },
    });
  } catch (error) {
    console.error('GET /share/me error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /api/share/u/:username — share kit for any public profile
router.get('/u/:username', async (req, res) => {
  try {
    const user = await User.findOne({
      username: new RegExp(`^${req.params.username}$`, 'i'),
    })
      .select('username name bio topCompanies profilePicture picture')
      .lean();

      

    if (!user) return res.status(404).json({ message: 'Profile not found' });

    res.json({ success: true, share: buildShareKit(user) });
  } catch (error) {
    console.error('GET /share/u/:username error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST /api/share/me/track — record that the mentor shared their profile
router.post('/me/track', protect, async (req, res) => {
  try {
    const via = normalizeSource(req.body?.via);
    await User.findByIdAndUpdate(req.user.userId, {
      $inc: { profileShares: 1 },
      $set: { lastSharedAt: new Date() },
    });
    res.json({ success: true, via });
  } catch (error) {
    console.error('POST /share/me/track error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /api/share/r/:username — tracked referral link (the one mentors post)
router.get('/r/:username', async (req, res) => {
   console.log("USERNAME =", req.params.username);
  const { username } = req.params;
  const via = normalizeSource(req.query.via);

  try {
    const user = await User.findOne({
      username: new RegExp(`^${username}$`, 'i'),
    })
      .select('username name bio topCompanies profilePicture picture')
      .lean();

       console.log("USER FOUND =", user);

    if (!user) {
      return res.redirect(302, (process.env.FRONTEND_URL || 'https://atyant.in'));
    }

    // Count the click (non-blocking).
    User.findByIdAndUpdate(user._id, {
      $inc: { referralClicks: 1, [`referralBySource.${via}`]: 1 },
    }).catch((err) => console.error('referralClicks increment error:', err.message));

    const target = buildLandingUrl(user.username, { via });

    console.log("TARGET =", target);

    // ── Topmate-style unfurl ──────────────────────────────────────────────────
    // We serve the SAME Open Graph HTML to EVERYONE (not just detected crawlers),
    // then redirect real browsers with JavaScript. Crawlers don't run JS, so they
    // read the OG tags reliably — no fragile user-agent sniffing, which was the
    // thing that left LinkedIn on a plain redirect and showing "Cannot display
    // preview". Real humans hit the <script> and land on the profile instantly.
    const kit = buildShareKit(user);
    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const { title, description, image } = kit.meta;

    // Let crawlers cache the unfurl card briefly so stale failures don't stick.
    res.set('Cache-Control', 'public, max-age=300');

    return res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Atyant">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(target)}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:secure_url" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(title)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<link rel="canonical" href="${esc(target)}">
<script>window.location.replace(${JSON.stringify(target)});</script>
</head><body>
<p>${esc(title)} — <a href="${esc(target)}">view profile on Atyant</a>.</p>
</body></html>`);
  } catch (error) {
    console.error('GET /share/r/:username error:', error);
    return res.redirect(302, (process.env.FRONTEND_URL || 'https://atyant.in'));
  }
});

export default router;