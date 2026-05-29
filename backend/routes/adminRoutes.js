import express from 'express';
import Question   from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import User       from '../models/User.js';
import protect    from '../middleware/authMiddleware.js';
import { getQuestionEmbedding } from '../services/AIService.js';  // 🔴 FIX: static import

const router = express.Router();

// ─── Guard middleware — apply once for all admin routes ─────────────────────
router.use(protect, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
});

// ─────────────────────────────────────────────
//  GET all published AnswerCards
// ─────────────────────────────────────────────
router.get('/answercards', async (req, res) => {
  try {
    const answerCards = await AnswerCard.find({ status: 'published' })
      .select('answerContent mentorId createdAt')
      .sort({ createdAt: -1 })
      .populate('mentorId', 'username')
      .lean();

    res.json({
      success    : true,
      answerCards: answerCards.map(card => ({
        id        : card._id,
        mainAnswer: card.answerContent?.mainAnswer || '',
        mentorName: card.mentorId?.username || '',
        createdAt : card.createdAt
      }))
    });
  } catch (e) {
    console.error('admin/answercards error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
//  GET all pending questions
// ─────────────────────────────────────────────
router.get('/pending-questions', async (req, res) => {
  try {
    const questions = await Question.find({
      status: { $in: ['pending', 'mentor_assigned', 'answered_instantly'] }
    })
      .select('questionText selectedMentorId answerCardId isFollowUp parentQuestionId createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Bulk-fetch mentors for assigned questions
    const mentorIds = [...new Set(
      questions.map(q => q.selectedMentorId?.toString()).filter(Boolean)
    )];

    // Also fetch mentorIds from AnswerCards for instant answers
    const cardIds = questions
      .filter(q => !q.selectedMentorId && q.answerCardId)
      .map(q => q.answerCardId);

    const [mentors, cards] = await Promise.all([
      mentorIds.length
        ? User.find({ _id: { $in: mentorIds } }).select('username name').lean()
        : [],
      cardIds.length
        ? AnswerCard.find({ _id: { $in: cardIds } }).select('mentorId').lean()
        : []
    ]);

    const mentorMap  = new Map(mentors.map(m => [m._id.toString(), m]));
    const cardMentor = new Map(cards.map(c => [c._id.toString(), c.mentorId?.toString()]));

    const result = questions.map(q => {
      let mentorId = q.selectedMentorId?.toString();
      if (!mentorId && q.answerCardId) {
        mentorId = cardMentor.get(q.answerCardId.toString());
      }
      const mentor = mentorId ? mentorMap.get(mentorId) : null;
      return {
        id               : q._id,
        text             : q.questionText,
        matchedMentorId  : mentorId || null,
        matchedMentorName: mentor ? (mentor.name || mentor.username) : '',
        matchConfidence  : 90,
        createdAt        : q.createdAt,
        isFollowUp       : q.isFollowUp || false,
        parentQuestionId : q.parentQuestionId || null
      };
    });

    res.json({ success: true, questions: result });
  } catch (e) {
    console.error('admin/pending-questions error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
//  POST publish answer as AnswerCard
// ─────────────────────────────────────────────
router.post('/answer', async (req, res) => {
  try {
    const { questionId, mentorId, answerContent } = req.body;

    if (!questionId || !mentorId || !answerContent) {
      return res.status(400).json({ success: false, error: 'questionId, mentorId, answerContent required' });
    }

    // Generate embedding (non-blocking fail — card still saves)
    let embedding = null;
    try {
      const embeddingText = [
        answerContent.mainAnswer,
        answerContent.situation,
        answerContent.firstAttempt,
        answerContent.whatWorked,
        answerContent.differentApproach,
        answerContent.additionalNotes
      ].filter(Boolean).join(' ');

      if (embeddingText.length > 20) {
        embedding = await getQuestionEmbedding(embeddingText);
        console.log(`✅ Admin answer embedding: ${embedding?.length || 0} dims`);
      }
    } catch (embErr) {
      console.error('⚠️ Embedding failed (card will save without it):', embErr.message);
    }

    const answerCard = await AnswerCard.create({
      questionId,
      mentorId,
      answerContent,
      ...(embedding ? { embedding } : {}),
      publishedBy: req.user._id,
      publishedAt: new Date(),
      status     : 'published'
    });

    await Question.findByIdAndUpdate(questionId, {
      status      : 'delivered',
      answerCardId: answerCard._id
    });

    res.json({ success: true, answerCard });
  } catch (e) {
    console.error('admin/answer error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
