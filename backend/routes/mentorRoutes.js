import express from 'express';
import User from '../models/User.js';
import Question from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import protect from '../middleware/authMiddleware.js';
import atyantEngine from '../services/AtyantEngine.js';
import { getQuestionEmbedding } from '../services/AIService.js';
import { normalizeCollege } from '../utils/collegeNormalizer.js';

const router = express.Router();

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const arr = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

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

    // ── Completeness gate (replaces admin approval) ──
    const missing = [];
    if (!college) missing.push('college');
    if (!branch) missing.push('branch');
    if (topCompanies.length === 0 && specialTags.length === 0) missing.push('at least one company or achievement tag');
    if (story.length < 120) missing.push('a fuller story (min ~120 characters)');
    const listed = missing.length === 0;

    // ── Write the mentor profile ──
    user.role = 'mentor';
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

    // ── Turn the story into an embedded AnswerCard (vector match + "Their Journey") ──
    let answerCardId = null;
    if (story.length >= 40) {
      try {
        const goalLine = primaryDomain ? `${primaryDomain} success` : 'their goal';
        const q = await Question.create({
          userId: user._id,
          questionText: `How did ${user.username || 'this mentor'} achieve ${goalLine}? (${(college || 'college')} ${(branch || '')})`.slice(0, 1000),
          status: 'answered_instantly',
          selectedMentorId: user._id,
          keywords: [...topCompanies, ...specialTags, branch].filter(Boolean).map(s => String(s).toLowerCase()),
        });

        const answerContent = {
          mainAnswer: story.slice(0, 2000),
          situation: story.slice(0, 1200),
          whatWorked: topCompanies[0] ? `Now at ${topCompanies[0]}` : '',
        };

        let embedding = null;
        try {
          const embText = [bio, story, topCompanies.join(' '), specialTags.join(' '), expertise.join(' ')]
            .filter(Boolean).join(' ');
          embedding = await getQuestionEmbedding(embText);
        } catch (e) {
          console.warn('onboard embedding failed (card saves without vector):', e.message);
        }

        const card = await AnswerCard.create({
          mentorId: user._id,
          questionId: q._id,
          answerContent,
          ...(embedding ? { embedding } : {}),
        });
        answerCardId = card._id;
      } catch (e) {
        console.error('onboard AnswerCard creation failed (non-fatal):', e.message);
      }
    }

    // ── Make them visible to the engine right away ──
    try { atyantEngine.flushAllCaches(); } catch { /* noop */ }

    return res.json({
      success: true,
      listed,
      missing,
      answerCardId,
      message: listed
        ? "You're live! Students matching your background will now find you."
        : 'Profile saved. Finish the missing fields to start getting matched.',
    });
  } catch (error) {
    console.error('POST /mentor/onboard error:', error);
    res.status(500).json({ message: 'Onboarding failed', error: error.message });
  }
});

export default router;
