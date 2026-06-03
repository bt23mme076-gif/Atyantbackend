import express from 'express';
import User from '../models/User.js';
import { optionalAuth } from '../middleware/auth.js';
import atyantEngine from '../services/AtyantEngine.js';
import { generateProblemStatement } from '../services/ProblemStatementGenerator.js';
import { normalizeCollege, buildCollegeRegex, isSameBranch } from '../utils/collegeNormalizer.js';

const router = express.Router();

// Response cache by query+college+branch for 5 minutes
const clarityCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(query, college, branch) {
  return `${query?.toLowerCase().trim()}|${college || ''}|${branch || ''}`;
}

// Build a short, specific "why matched" line from real shared signals.
function buildMatchReason(mentor, ctx) {
  const mEdu = mentor.education?.[0] || {};
  const mCollege = (mEdu.institutionName || '').trim();
  const mBranch = (mEdu.field || '').trim();
  const company = (mentor.topCompanies || [])[0];

  if (ctx.college && mCollege && mCollege.toLowerCase().includes(ctx.college.toLowerCase().split(' ')[0]))
    return `Same college — ${mCollege}${mBranch ? `, ${mBranch}` : ''}`;
  if (isSameBranch(ctx.branch, mBranch))
    return `Same branch — ${mBranch}${company ? `, now at ${company}` : ''}`;
  if (company) return `Cracked ${company} from a similar background`;
  if ((mentor.expertise || []).length) return `Expert in ${mentor.expertise.slice(0, 2).join(', ')}`;
  return 'Matched on your goal and background';
}

function buildTags(mentor, ctx) {
  const tags = [];
  const mEdu = mentor.education?.[0] || {};
  if (ctx.college && (mEdu.institutionName || '').toLowerCase().includes(ctx.college.toLowerCase().split(' ')[0])) tags.push('Same College');
  if (isSameBranch(ctx.branch, mEdu.field)) tags.push('Same Branch');
  (mentor.specialTags || []).slice(0, 3).forEach(t => tags.push(t));
  if (tags.length === 0) tags.push('Verified Mentor');
  return [...new Set(tags)].slice(0, 5);
}

// POST /api/clarity/match — public, no login needed
router.post('/match', optionalAuth, async (req, res) => {
  try {
    const { query, college, branch, year, goal, cgpa, gap, timeline, constraints } = req.body;

    if (!query || query.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'Query too short' });
    }

    const cacheKey = getCacheKey(query, college, branch);
    const cached = clarityCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json({ ...cached.payload, fromCache: true });
    }

    const userId = req.user?.userId || req.user?._id || null;
    const ctx = { college, branch };

    // 1. Build the structured problem statement from conversation context.
    const problem = generateProblemStatement(
      { college, branch, year, cgpa, goal: goal || query, gap, timeline, constraints },
      null
    );

    // engineText (structured brief) + raw query gives the richest vector signal.
    const engineQuery = [problem.engineText, query].filter(Boolean).join('\n');

    // 2. Dual output: AnswerCard + matched mentors, simultaneously.
    //    Pass the student's chat-collected identity so same-college / same-branch
    //    are credited in scoring even when the user is logged out (no DB profile).
    const clarity = await atyantEngine.getClarity(userId, engineQuery, {
      mentorLimit: 5,
      studentContext: { college, branch, year, goal: goal || query },
    });

    // 3. Enrich mentors with display fields (name/photo not in the match cache).
    const ids = (clarity.mentors || []).map(m => m._id);
    const display = ids.length
      ? await User.find({ _id: { $in: ids } })
          .select('name username profilePicture yearsOfExperience')
          .lean()
      : [];
    const dmap = new Map(display.map(d => [String(d._id), d]));

    const mentors = (clarity.mentors || []).map(m => {
      const d = dmap.get(String(m._id)) || {};
      const rawName = d.name || d.username || m.username || 'Mentor';
      const initials = rawName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
      const mEdu = m.education?.[0] || {};
      const company = (m.topCompanies || [])[0] || '';
      const role = (m.expertise || [])[0] || 'Industry Professional';
      return {
        id: String(m._id),
        name: rawName,
        initials,
        role,
        company,
        college: mEdu.institutionName || '',
        branch: mEdu.field || '',
        matchPct: m.matchScore || 0,
        matchReason: buildMatchReason(m, ctx),
        verifiedVia: 'LinkedIn',
        story: m.bio || 'Walked a similar path and now mentors students on Atyant.',
        outcome: company ? `${role} @ ${company}` : 'Active mentor on Atyant',
        tags: buildTags(m, ctx),
        studentsHelped: String(m.successfulMatches || 0),
        rating: m.rating ? `${m.rating.toFixed(1)}★` : '4.8★',
        timeline: d.yearsOfExperience ? `${d.yearsOfExperience} yrs exp` : 'Active',
        profilePicture: d.profilePicture || null,
      };
    });

    const payload = {
      ok: true,
      mentors,
      answerCard: clarity.answerCard,        // instant verified answer (or null)
      hasInstantAnswer: clarity.hasInstantAnswer,
      problemStatement: problem.statement,   // full statement incl. confidence
      confidence: problem.confidence,
    };

    clarityCache.set(cacheKey, { payload, ts: Date.now() });
    if (clarityCache.size > 100) {
      const oldest = [...clarityCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      clarityCache.delete(oldest[0]);
    }

    res.json(payload);
  } catch (err) {
    console.error('Clarity match error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Community count cache (5 min) — keyed by normalized college
const countCache = new Map();
const COUNT_TTL = 5 * 60 * 1000;

// GET /api/clarity/community-count?college=VNIT Nagpur
// Counts everyone (mentors + students) from that college, alias-aware.
router.get('/community-count', optionalAuth, async (req, res) => {
  try {
    const college = (req.query.college || '').trim();
    if (!college) return res.json({ ok: true, count: 0 });

    // Key by canonical college so "vnit" and "Visvesvaraya National Institute
    // of Technology (VNIT), Nagpur" hit the same cached count.
    const cacheKey = normalizeCollege(college).toLowerCase();
    const cached = countCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < COUNT_TTL) {
      return res.json({ ok: true, count: cached.count, fromCache: true });
    }

    // Match any known alias of the college across both education field names.
    const regex = buildCollegeRegex(college);
    const count = await User.countDocuments({
      $or: [
        { 'education.institutionName': regex },
        { 'education.institution': regex },
      ],
    });

    countCache.set(cacheKey, { count, ts: Date.now() });
    res.json({ ok: true, count });
  } catch (err) {
    console.error('community-count error:', err);
    res.json({ ok: true, count: 0 }); // never break the hero on a count failure
  }
});

export default router;
