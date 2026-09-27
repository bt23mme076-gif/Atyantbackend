import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import Review, { REVIEW_KINDS, REVIEW_TAGS } from '../models/Review.js';
import MockInterview from '../models/MockInterview.js';
import Session from '../models/Session.js';
import protect from '../middleware/authMiddleware.js';
import { applySessionReview } from '../services/reviewService.js';

const router = express.Router();

// Platform feedback is open to signed-out visitors, so cap submissions per IP.
const platformLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too much feedback from this network. Try again in an hour.' },
});

// Signed-in if a token is sent (same decoding as every other protected route), guest otherwise.
const authIfPresent = (req, res, next) => (req.headers.authorization || req.cookies?.token ? protect(req, res, next) : next());

const userIdOf = (req) => req.user?.userId || req.user?._id || req.user?.id || null;

// ─────────────────────────────────────────────
//  POST /api/reviews
//  Body: { kind, target?, rating (1–5), tags?[], comment?, page? }
//  platform       — auth optional; one per signed-in user per day.
//  mock_interview — auth required; your own finished interview; one each.
//  session        — auth required; your own session; one each. Also updates
//                   Session.review + the mentor's rating (applySessionReview).
// ─────────────────────────────────────────────
router.post('/', authIfPresent, (req, res, next) => (req.body?.kind === 'platform' ? platformLimiter(req, res, next) : next()), async (req, res) => {
  try {
    const { kind, target, page } = req.body || {};
    if (!REVIEW_KINDS.includes(kind)) return res.status(400).json({ message: 'Unknown feedback type' });

    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Pick a rating from 1 to 5 stars' });

    const allowedTags = REVIEW_TAGS[kind];
    const tags = Array.isArray(req.body.tags) ? [...new Set(req.body.tags.filter(t => allowedTags.includes(t)))] : [];
    const comment = String(req.body.comment || '').trim().slice(0, 1000);
    const userId = userIdOf(req);

    if (kind !== 'platform' && !userId) return res.status(401).json({ message: 'Sign in to rate this' });
    if (kind !== 'platform' && !mongoose.isValidObjectId(target)) return res.status(400).json({ message: 'Missing what you are rating' });

    let label = '';

    if (kind === 'mock_interview') {
      const iv = await MockInterview.findOne({ _id: target, userId }).select('status company role').lean();
      if (!iv) return res.status(404).json({ message: 'Interview not found' });
      if (iv.status !== 'completed') return res.status(400).json({ message: 'You can rate an interview once it has finished' });
      label = [iv.company, iv.role].filter(Boolean).join(' · ');
    }

    if (kind === 'session') {
      const session = await Session.findOne({ _id: target, userId });
      if (!session) return res.status(404).json({ message: 'Session not found' });
      if (session.review?.submittedAt) return res.status(409).json({ message: 'You already rated this session' });
      await applySessionReview(session, rating, comment);
      label = session.mentorName || '';
    }

    if (kind === 'platform' && userId) {
      const recent = await Review.exists({ kind: 'platform', user: userId, createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
      if (recent) return res.status(429).json({ message: 'Thanks, we already have your feedback from today.' });
    }

    const review = await Review.create({
      kind,
      user: userId,
      target: kind === 'platform' ? null : target,
      rating,
      tags,
      comment,
      context: { page: String(page || '').slice(0, 60), label: label.slice(0, 120) },
    });

    res.status(201).json({ review: { _id: review._id, kind, rating, tags, comment, createdAt: review.createdAt } });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: 'You already rated this' });
    console.error('POST /api/reviews error:', err);
    res.status(500).json({ message: 'Could not save your feedback' });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reviews/mine?kind=mock_interview&target=<id>
//  Your existing review for one interview/session (so the UI doesn't ask twice),
//  or your latest platform feedback when no target is given.
// ─────────────────────────────────────────────
router.get('/mine', protect, async (req, res) => {
  try {
    const { kind, target } = req.query;
    if (!REVIEW_KINDS.includes(kind)) return res.status(400).json({ message: 'Unknown feedback type' });
    const query = { kind, user: userIdOf(req) };
    if (target) {
      if (!mongoose.isValidObjectId(target)) return res.status(400).json({ message: 'Invalid target' });
      query.target = target;
    }
    const review = await Review.findOne(query).sort({ createdAt: -1 }).select('kind rating tags comment createdAt').lean();
    res.json({ review: review || null });
  } catch (err) {
    console.error('GET /api/reviews/mine error:', err);
    res.status(500).json({ message: 'Could not load your feedback' });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reviews/summary  — admin only
//  Average + count per kind, tag counts, and the latest 50 comments.
// ─────────────────────────────────────────────
router.get('/summary', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });

    const [byKind, byTag, latest] = await Promise.all([
      Review.aggregate([{ $group: { _id: '$kind', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } }]),
      Review.aggregate([{ $unwind: '$tags' }, { $group: { _id: { kind: '$kind', tag: '$tags' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Review.find({ comment: { $ne: '' } }).sort({ createdAt: -1 }).limit(50).select('kind rating tags comment context createdAt').lean(),
    ]);

    res.json({
      kinds: byKind.map(k => ({ kind: k._id, count: k.count, avgRating: Math.round(k.avgRating * 10) / 10 })),
      tags: byTag.map(t => ({ kind: t._id.kind, tag: t._id.tag, count: t.count })),
      latest,
    });
  } catch (err) {
    console.error('GET /api/reviews/summary error:', err);
    res.status(500).json({ message: 'Could not load the summary' });
  }
});

export default router;
