import express from 'express';
import User from '../models/User.js';
import Question from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import Session from '../models/Session.js';
import protect from '../middleware/authMiddleware.js';
import atyantEngine from '../services/AtyantEngine.js';
import aiService, { getQuestionEmbedding } from '../services/AIService.js';
import { normalizeCollege } from '../utils/collegeNormalizer.js';
import { sendMentorWelcomeEmail } from '../utils/emailService.js';
import { generateSlug, validateSlug } from '../utils/slugGenerator.js';
import { extractLinkedInProfile } from '../services/LinkedInService.js';

const router = express.Router();

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const arr = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/mentor/linkedin-autofill
//  Scrapes a LinkedIn profile URL and returns pre-filled mentor fields.
//  Does NOT save anything — frontend uses the response to populate the form.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/linkedin-autofill', protect, async (req, res) => {
  try {
    const linkedinUrl = clean(req.body?.linkedinUrl);
    if (!linkedinUrl) {
      return res.status(400).json({ success: false, message: 'linkedinUrl is required' });
    }
    const fields = await extractLinkedInProfile(linkedinUrl);
    return res.json({ success: true, fields });
  } catch (err) {
    console.error('POST /mentor/linkedin-autofill error:', err.message);
    const isConfig = err.message.includes('APIFY_API_TOKEN');
    return res.status(isConfig ? 503 : 422).json({
      success: false,
      message: isConfig
        ? 'LinkedIn import is not configured on this server.'
        : err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/mentor/onboard
//  One-shot mentor onboarding (no admin approval). Saves the matching fields,
//  creates an embedded AnswerCard from their story, and — if the profile is
//  complete enough — lists them in the live matching pool immediately.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/onboard', protect, async (req, res) => {
  try {
    const userId = req.user.userId;
    const b = req.body || {};

    const username = clean(b.username);
    const college = clean(b.college);
    const branch = clean(b.branch);
    const year = clean(b.year);
    const degree = clean(b.degree) || 'B.Tech';
    const cgpa = b.cgpa != null && b.cgpa !== '' ? Number(b.cgpa) : undefined;

    const topCompanies = arr(b.topCompanies);
    const specialTags = arr(b.specialTags);
    const expertise = arr(b.expertise);
    const bio = clean(b.bio) || '';
    const city = clean(b.city) || '';
    const linkedinProfile = clean(b.linkedinProfile) || '';
    const story = clean(b.story) || '';

    const primaryDomain = ['internship', 'placement', 'both'].includes(b.primaryDomain) ? b.primaryDomain : null;
    const companyDomain = ['Tech', 'Data Analytics', 'Consulting', 'Product', 'Core Engineering'].includes(b.companyDomain)
      ? b.companyDomain : null;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Send the mentor welcome only the first time they become a mentor
    // (not on subsequent profile edits via this route).
    const isNewMentor = user.role !== 'mentor' && !user.mentorOnboardedAt;

    // ── Completeness gate (replaces admin approval) ──
    const missing = [];
    if (!college) missing.push('college');
    if (!branch) missing.push('branch');
    if (topCompanies.length === 0 && specialTags.length === 0) missing.push('at least one company or achievement tag');
    if (story.length < 120) missing.push('a fuller story (min ~120 characters)');
    const listed = missing.length === 0;

    // ── Write the mentor profile ──
    user.role = 'mentor';
    if (username && username !== user.username) {
      // Only update if the name was actually changed in the wizard (e.g. after LinkedIn import)
      const taken = await User.findOne({ username, _id: { $ne: user._id } }).lean();
      if (!taken) user.username = username;
    }
    
    // Generate slug from name if not already set
    if (!user.slug) {
      const mentorName = user.name || username;
      if (mentorName) {
        try {
          user.slug = await generateSlug(mentorName);
        } catch (e) {
          console.warn('Failed to generate slug for mentor:', e.message);
        }
      }
    }
    
    user.education = [{
      institutionName: college || user.education?.[0]?.institutionName || '',
      institution: college || user.education?.[0]?.institution || '',
      degree,
      field: branch || user.education?.[0]?.field || '',
      year: year || user.education?.[0]?.year || '',
      ...(Number.isFinite(cgpa) ? { cgpa } : {}),
    }];
    user.topCompanies = topCompanies;
    user.specialTags = specialTags;
    user.expertise = expertise;
    if (bio) user.bio = bio.slice(0, 500);
    if (city) user.city = city;
    if (linkedinProfile) user.linkedinProfile = linkedinProfile;
    user.primaryDomain = primaryDomain;
    user.companyDomain = companyDomain;
    user.mentorListed = listed;
    user.mentorOnboardedAt = new Date();
    user.lastActive = new Date();

    await user.save();

    // ── Make them visible to the engine right away ──
    try { atyantEngine.flushAllCaches(); } catch { /* noop */ }

    // ── Mentor welcome / how-Atyant-helps-you email (first onboard only, non-blocking) ──
    if (isNewMentor) {
      sendMentorWelcomeEmail(user.email, user.name || user.username)
        .catch(err => console.error('Mentor welcome email failed (non-fatal):', err.message));
    }

    // ── Return immediately — AnswerCard creation (AI refine + embedding) runs in background ──
    res.json({
      success: true,
      listed,
      missing,
      answerCardId: null,
      message: listed
        ? "You're live! Students matching your background will now find you."
        : 'Profile saved. Finish the missing fields to start getting matched.',
    });

    // ── Background: Turn the story into an embedded AnswerCard ──
    if (story.length >= 40) {
      (async () => {
        try {
          const goalLine = primaryDomain ? `${primaryDomain} success` : 'their goal';
          const q = await Question.create({
            userId: user._id,
            questionText: `How did ${user.username || 'this mentor'} achieve ${goalLine}? (${(college || 'college')} ${(branch || '')})`.slice(0, 1000),
            status: 'answered_instantly',
            selectedMentorId: user._id,
            keywords: [...topCompanies, ...specialTags, branch].filter(Boolean).map(s => String(s).toLowerCase()),
          });

          let refined = null;
          try {
            refined = await aiService.refineExperience({
              story, bio, college, branch,
              companies: topCompanies, expertise, achievements: specialTags,
            });
          } catch (e) {
            console.warn('onboard refineExperience failed, using raw story:', e.message);
          }

          const answerContent = buildAnswerContent({
            mainAnswer: refined?.mainAnswer,
            situation: refined?.situation,
            whatWorked: refined?.whatWorked,
            timeline: refined?.timeline,
            differentApproach: refined?.differentApproach,
            keyMistakes: refined?.keyMistakes,
            actionableSteps: refined?.actionableSteps,
          });
          if (!answerContent.situation)  answerContent.situation = story.slice(0, 1200);
          if (!answerContent.mainAnswer) answerContent.mainAnswer = story.slice(0, 200);
          if (!answerContent.whatWorked && topCompanies[0]) answerContent.whatWorked = `Now at ${topCompanies[0]}`;

          let embedding = null;
          try {
            const embText = [
              embeddingTextFor(answerContent), topCompanies.join(' '), specialTags.join(' '), expertise.join(' '),
            ].filter(Boolean).join(' ');
            embedding = await getQuestionEmbedding(embText);
          } catch (e) {
            console.warn('onboard embedding failed (card saves without vector):', e.message);
          }

          await AnswerCard.create({
            mentorId: user._id,
            questionId: q._id,
            answerContent,
            ...(embedding ? { embedding } : {}),
          });

          try { atyantEngine.flushAllCaches(); } catch { /* noop */ }
        } catch (e) {
          console.error('onboard AnswerCard creation failed (non-fatal):', e.message);
        }
      })();
    }
  } catch (error) {
    console.error('POST /mentor/onboard error:', error);
    res.status(500).json({ message: 'Onboarding failed', error: error.message });
  }
});

// Build the embedding text + content from an answer-card request body.
function buildAnswerContent(b = {}) {
  const ac = {
    mainAnswer:        typeof b.mainAnswer === 'string' ? b.mainAnswer.slice(0, 2000) : '',
    situation:         typeof b.situation === 'string' ? b.situation.slice(0, 2000) : '',
    whatWorked:        typeof b.whatWorked === 'string' ? b.whatWorked.slice(0, 2000) : '',
    timeline:          typeof b.timeline === 'string' ? b.timeline.slice(0, 500) : '',
    differentApproach: typeof b.differentApproach === 'string' ? b.differentApproach.slice(0, 2000) : '',
    keyMistakes:       Array.isArray(b.keyMistakes)
      ? b.keyMistakes.map(s => String(s).trim()).filter(Boolean).slice(0, 10) : [],
    actionableSteps:   Array.isArray(b.actionableSteps)
      ? b.actionableSteps
          .map(s => ({ step: String(s?.step || '').trim(), description: String(s?.description || '').trim() }))
          .filter(s => s.description).slice(0, 10)
      : [],
  };
  return ac;
}

function embeddingTextFor(ac) {
  return [
    ac.mainAnswer, ac.situation, ac.whatWorked, ac.timeline, ac.differentApproach,
    Array.isArray(ac.keyMistakes) ? ac.keyMistakes.join(' ') : '',
    Array.isArray(ac.actionableSteps) ? ac.actionableSteps.map(s => s.description).join(' ') : '',
  ].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/mentor/answer-cards/generate
//  AI-drafts a full answer card from ONE paragraph the mentor writes (plus their
//  profile). Does NOT save — returns the structured draft so the mentor can
//  review/tweak it, then publish. This is the "mentors won't fill 6 boxes" path.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/answer-cards/generate', protect, async (req, res) => {
  try {
    const mentorId = req.user.userId;
    const user = await User.findById(mentorId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const story = clean(req.body?.story) || '';
    const edu = user.education?.[0] || {};

    // Feed the AI everything we know — the free-text story is the main signal,
    // profile fields add grounding (companies, skills, achievements).
    const rawData = {
      story: story || user.bio || '',
      bio: user.bio || '',
      college: edu.institutionName || edu.institution || '',
      branch: edu.field || '',
      companies: user.topCompanies || [],
      expertise: user.expertise || [],
      achievements: user.specialTags || [],
    };

    if (!rawData.story && rawData.companies.length === 0) {
      return res.status(400).json({ message: 'Write a few lines about your journey first.' });
    }

    let refined;
    try {
      refined = await aiService.refineExperience(rawData);
    } catch (e) {
      console.warn('refineExperience failed, using raw:', e.message);
      refined = rawData;
    }

    const ac = buildAnswerContent({
      mainAnswer: refined?.mainAnswer,
      situation: refined?.situation,
      whatWorked: refined?.whatWorked,
      timeline: refined?.timeline,
      differentApproach: refined?.differentApproach,
      keyMistakes: refined?.keyMistakes,
      actionableSteps: refined?.actionableSteps,
    });

    // Safety net: if AI was unavailable (no key), at least seed from the story
    // so the mentor isn't staring at empty boxes.
    if (!ac.situation && !ac.mainAnswer && rawData.story) {
      ac.situation = rawData.story.slice(0, 1200);
      ac.mainAnswer = rawData.story.slice(0, 200);
    }

    res.json({ success: true, answerContent: ac });
  } catch (err) {
    console.error('POST /mentor/answer-cards/generate error:', err);
    res.status(500).json({ message: 'Failed to generate answer card', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/mentor/answer-cards
//  Lets a mentor write their answer card from scratch (when one wasn't auto-
//  created at onboarding). Creates the backing Question + embedded AnswerCard.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/answer-cards', protect, async (req, res) => {
  try {
    const mentorId = req.user.userId;
    const user = await User.findById(mentorId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'mentor') return res.status(403).json({ message: 'Only mentors can create answer cards' });

    const ac = buildAnswerContent(req.body);
    // Need at least the headline or the situation to make a meaningful card.
    if (!ac.mainAnswer && !ac.situation) {
      return res.status(400).json({ message: 'Add at least a headline answer or the situation.' });
    }

    const edu = user.education?.[0] || {};
    const college = edu.institutionName || edu.institution || 'college';
    const branch = edu.field || '';
    const goalLine = user.primaryDomain ? `${user.primaryDomain} success` : 'their goal';

    const q = await Question.create({
      userId: user._id,
      questionText: `How did ${user.username || 'this mentor'} achieve ${goalLine}? (${college} ${branch})`.slice(0, 1000),
      status: 'answered_instantly',
      selectedMentorId: user._id,
      keywords: [...(user.topCompanies || []), ...(user.specialTags || []), branch]
        .filter(Boolean).map(s => String(s).toLowerCase()),
    });

    let embedding = null;
    try {
      embedding = await getQuestionEmbedding(embeddingTextFor(ac));
    } catch (e) {
      console.warn('create answer-card embedding failed (saves without vector):', e.message);
    }

    const card = await AnswerCard.create({
      mentorId: user._id,
      questionId: q._id,
      answerContent: ac,
      ...(embedding ? { embedding } : {}),
    });

    try { atyantEngine.flushAllCaches(); } catch { /* noop */ }

    res.json({
      success: true,
      message: 'Answer card created',
      card: { id: String(card._id), questionText: q.questionText, answerContent: ac, updatedAt: card.updatedAt },
    });
  } catch (err) {
    console.error('POST /mentor/answer-cards error:', err);
    res.status(500).json({ message: 'Failed to create answer card', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/mentor/answer-cards
//  The logged-in mentor's own answer cards — exactly what students see on the
//  Clarity page, so the mentor can review and edit them.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/answer-cards', protect, async (req, res) => {
  try {
    const mentorId = req.user.userId;
    const cards = await AnswerCard.find({ mentorId })
      .sort({ createdAt: -1 })
      .populate('questionId', 'questionText')
      .lean();

    res.json({
      success: true,
      cards: cards.map(c => ({
        id: String(c._id),
        questionText: c.questionId?.questionText || '',
        answerContent: c.answerContent || {},
        updatedAt: c.updatedAt,
      })),
    });
  } catch (err) {
    console.error('GET /mentor/answer-cards error:', err);
    res.status(500).json({ message: 'Failed to load answer cards', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/mentor/answer-cards/:id
//  Edit the content of one of the mentor's own answer cards. Re-generates the
//  vector embedding from the new content so semantic matching stays accurate.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/answer-cards/:id', protect, async (req, res) => {
  try {
    const mentorId = req.user.userId;
    // Scope to the owner — a mentor can only edit their own cards.
    const card = await AnswerCard.findOne({ _id: req.params.id, mentorId });
    if (!card) return res.status(404).json({ message: 'Answer card not found' });

    const b = req.body || {};
    const ac = card.answerContent || {};

    // Update only the fields the editor actually sends (string fields capped).
    if (typeof b.mainAnswer === 'string')        ac.mainAnswer = b.mainAnswer.slice(0, 2000);
    if (typeof b.situation === 'string')         ac.situation = b.situation.slice(0, 2000);
    if (typeof b.whatWorked === 'string')        ac.whatWorked = b.whatWorked.slice(0, 2000);
    if (typeof b.timeline === 'string')          ac.timeline = b.timeline.slice(0, 500);
    if (typeof b.differentApproach === 'string') ac.differentApproach = b.differentApproach.slice(0, 2000);
    if (Array.isArray(b.keyMistakes)) {
      ac.keyMistakes = b.keyMistakes.map(s => String(s).trim()).filter(Boolean).slice(0, 10);
    }
    if (Array.isArray(b.actionableSteps)) {
      ac.actionableSteps = b.actionableSteps
        .map(s => ({ step: String(s?.step || '').trim(), description: String(s?.description || '').trim() }))
        .filter(s => s.description)
        .slice(0, 10);
    }

    card.answerContent = ac;
    card.markModified('answerContent');

    // Re-embed from the updated content so vector search reflects the edit.
    try {
      const embedding = await getQuestionEmbedding(embeddingTextFor(ac));
      if (embedding) card.embedding = embedding;
    } catch (e) {
      console.warn('answer-card re-embed failed (saved without new vector):', e.message);
    }

    await card.save();

    // Drop cached matches so students see the updated card/vector right away.
    try { atyantEngine.flushAllCaches(); } catch { /* noop */ }

    res.json({ success: true, message: 'Answer card updated', answerContent: ac });
  } catch (err) {
    console.error('PUT /mentor/answer-cards/:id error:', err);
    res.status(500).json({ message: 'Failed to update answer card', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/mentor/availability  — mentor saves their weekly recurring schedule
// ─────────────────────────────────────────────────────────────────────────────
router.put('/availability', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ ok: false, error: 'Only mentors can set availability' });
    }
    const { weekly, timezone, advanceNoticeHours, maxWeeksAhead } = req.body || {};
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    user.availability = {
      weekly: (Array.isArray(weekly) ? weekly : [])
        .map(d => ({ day: Number(d.day), slots: (Array.isArray(d.slots) ? d.slots : []).filter(s => /^\d{2}:\d{2}$/.test(s)) }))
        .filter(d => d.day >= 0 && d.day <= 6),
      timezone:           typeof timezone === 'string' ? timezone : 'Asia/Kolkata',
      advanceNoticeHours: Math.max(0, Number(advanceNoticeHours) || 2),
      maxWeeksAhead:      Math.min(8, Math.max(1, Number(maxWeeksAhead) || 3)),
    };
    user.markModified('availability');
    await user.save();
    res.json({ ok: true, availability: user.availability });
  } catch (err) {
    console.error('PUT /mentor/availability error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/mentor/:id/availability  — public: weekly schedule template
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/availability', async (req, res) => {
  try {
    const mentor = await User.findById(req.params.id)
      .select('availability role').lean();
    if (!mentor || mentor.role !== 'mentor') {
      return res.status(404).json({ ok: false, error: 'Mentor not found' });
    }
    res.json({ ok: true, availability: mentor.availability || { weekly: [], timezone: 'Asia/Kolkata', advanceNoticeHours: 2, maxWeeksAhead: 3 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/mentor/:id/slots?date=YYYY-MM-DD  — available slots on a date
//  Returns slots not already booked and still far enough in the future.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'date query param required (YYYY-MM-DD)' });
    }
    const mentor = await User.findById(req.params.id).select('availability role').lean();
    if (!mentor || mentor.role !== 'mentor') {
      return res.status(404).json({ ok: false, error: 'Mentor not found' });
    }
    const [y, mo, d] = date.split('-').map(Number);
    const dayOfWeek = new Date(y, mo - 1, d).getDay();
    const weekDay = (mentor.availability?.weekly || []).find(w => w.day === dayOfWeek);
    if (!weekDay?.slots?.length) return res.json({ ok: true, slots: [], date });

    // Booked sessions for this mentor on this local date (IST UTC+5:30)
    const startIST = new Date(`${date}T00:00:00+05:30`);
    const endIST   = new Date(`${date}T23:59:59+05:30`);
    const booked = await Session.find({
      mentorId: req.params.id,
      scheduledAt: { $gte: startIST, $lte: endIST },
      status: { $nin: ['cancelled'] },
    }).select('scheduledAt').lean();

    const bookedSet = new Set(booked.map(s => {
      const t = new Date(new Date(s.scheduledAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    }));

    const advanceMs  = (mentor.availability?.advanceNoticeHours || 2) * 3600_000;
    const cutoffMs   = Date.now() + advanceMs;
    const allFutureSlots = weekDay.slots.filter(slot => {
      const slotMs = new Date(`${date}T${slot}:00+05:30`).getTime();
      return slotMs > cutoffMs;
    });
    const bookedSlots = allFutureSlots.filter(slot => bookedSet.has(slot));

    res.json({ ok: true, slots: allFutureSlots, bookedSlots, date });
  } catch (err) {
    console.error('GET /mentor/:id/slots error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/mentor/:slug
//  Public endpoint to fetch mentor profile by slug (for public profile URLs)
//  No authentication required - completely public
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'Slug is required' });
    }
    
    // Find mentor by slug, then case-insensitive username fallback
    const query = slug.toLowerCase();
    const mentor = await User.findOne({
      $or: [
        { slug: query },
        { username: { $regex: new RegExp(`^${query}$`, 'i') } },
      ],
      role: 'mentor',
      mentorListed: { $ne: false } // Only listed mentors
    }).select(
      'name username email profilePicture bio city role primaryDomain companyDomain ' +
      'topCompanies specialTags expertise interests skills domainExperience ' +
      'education linkedinProfile socialLinks isVerified price servicesOffered ' +
      'yearsOfExperience rating responseRate outcomeScore outcomeCount outcomeSuccessCount ' +
      'profileViews totalChats feedbackScore totalAnswered helpfulCount feedbackCount'
    ).lean();
    
    if (!mentor) {
      return res.status(404).json({ ok: false, error: 'Mentor not found' });
    }
    
    // Increment profile view count
    await User.findByIdAndUpdate(mentor._id, { $inc: { profileViews: 1 } });
    
    res.json({ ok: true, mentor });
  } catch (err) {
    console.error('GET /mentor/:slug error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/mentor/slug
//  Allow mentor to customize their public profile slug
//  Requires authentication
// ─────────────────────────────────────────────────────────────────────────────
router.put('/slug', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ ok: false, error: 'Only mentors can update their slug' });
    }
    
    const { slug } = req.body;
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'Slug is required' });
    }
    
    // Validate slug format
    if (!validateSlug(slug)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid slug format. Use lowercase letters, numbers, and hyphens only (3-100 characters)' 
      });
    }
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    
    // Check if slug is already taken by another user
    const existing = await User.findOne({ 
      slug: slug.toLowerCase(),
      _id: { $ne: user._id }
    }).select('slug').lean();
    
    if (existing) {
      return res.status(409).json({ ok: false, error: 'This slug is already taken' });
    }
    
    // Update slug
    user.slug = slug.toLowerCase();
    await user.save();
    
    res.json({ ok: true, slug: user.slug });
  } catch (err) {
    console.error('PUT /mentor/slug error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
