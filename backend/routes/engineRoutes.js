import express from 'express';
import protect from '../middleware/authMiddleware.js';
import atyantEngine from '../services/AtyantEngine.js';
import Question from '../models/Question.js';
import AnswerCard from '../models/AnswerCard.js';
import MentorExperience from '../models/MentorExperience.js';
import User from '../models/User.js';
import { sendMentorNewQuestionNotification, sendUserAnswerReadyNotification } from '../utils/emailNotifications.js';

const router = express.Router();

/**
 * 1. STUDENT: Question Submit
 */
router.post('/submit-question', protect, async (req, res) => {
  try {
    const { questionText, preferredMentorId } = req.body;
    if (!questionText || questionText.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Question too short' });
    }
    const result = await atyantEngine.processQuestion(req.user.userId, questionText, { preferredMentorId: preferredMentorId || null });
    res.json(result);
  } catch (error) {
    console.error('Error submitting question:', error);
    res.status(500).json({ success: false, error: 'Failed to submit question' });
  }
});

/**
 * 2. STUDENT: Question Status & Answer Delivery
 * FIXES: Gear icon stuck, Header Text bug, and Full Card delivery
 */
router.get('/question-status/:questionId', protect, async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!questionId || questionId === "undefined" || questionId.length !== 24) {
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }

    // 🔥 DEEP POPULATE: Mentor data nested inside AnswerCard to stop loading gear
    let question = await Question.findOne({ _id: questionId, userId: req.user.userId });
    if (!question) return res.status(404).json({ success: false, error: 'Question not found' });

    // If this is a follow-up, redirect to parent question
    if (question.isFollowUp && question.parentQuestionId) {
      return res.json({
        success: true,
        redirect: true,
        parentQuestionId: question.parentQuestionId
      });
    }

    // Otherwise, fetch answer card as usual
    question = await Question.findOne({ _id: questionId, userId: req.user.userId })
      .populate({
        path: 'answerCardId',
        populate: { path: 'mentorId', select: 'name username bio expertise profileImage ratings' }
      });

    // 🚀 HEADER FIX: If it's a follow-up, send original question text as header
    let displayTitle = question.questionText;
    if (question.isFollowUp && question.parentQuestionId) {
      const parent = await Question.findById(question.parentQuestionId);
      if (parent) displayTitle = parent.questionText;
    }

    // 🚀 Always deliver structured answerContent object for both main and follow-up answers
    const formattedAnswer = question.answerCardId ? {
      ...question.answerCardId._doc,
      id: question.answerCardId._id,
      mentor: question.answerCardId.mentorId,
      content: typeof question.answerCardId.answerContent === 'object'
        ? question.answerCardId.answerContent
        : { mainAnswer: question.answerCardId.answerContent },
      isInstant: question.status === 'answered_instantly',
      matchScore: question.matchScore || 85
    } : null;

    res.json({
      success: true,
      question: { id: question._id, text: displayTitle, status: question.status },
      answerCard: formattedAnswer
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Status fetch failed' });
  }
});

/**
 * 3. MENTOR: Pending Dashboard (FIXED BLANK CARDS)
 * FIX: Mentor now sees the "🔄 FOLLOW-UP" tag on dashboard
 */
router.get('/mentor/pending-questions', protect, async (req, res) => {
  try {
    const questions = await Question.find({
      selectedMentorId: req.user.userId,
      status: { $in: ['mentor_assigned', 'awaiting_experience'] }
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      questions: questions.map(q => ({
        ...q._doc,
        id: q._id,
        _id: q._id,
        // 🚀 MAPPING FIX: Frontend expects '.text' property to display question
        text: q.isFollowUp ? `🔄 FOLLOW-UP: ${q.questionText}` : q.questionText,
        questionText: q.questionText,
        isFollowUp: q.isFollowUp,
        status: q.status,
        createdAt: q.createdAt ? new Date(q.createdAt).toISOString() : null
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

/**
 * 4. MENTOR: Answered History
 */
router.get('/mentor/answered-questions', protect, async (req, res) => {
  try {
    const questions = await Question.find({
      selectedMentorId: req.user.userId,
      status: { $in: ['experience_submitted', 'delivered'] }
    }).sort({ createdAt: -1 }).populate('answerCardId');

    res.json({
      success: true,
      questions: questions.map(q => ({
        id: q._id,
        text: q.questionText,
        status: q.status,
        createdAt: q.createdAt,
        hasAnswerCard: !!q.answerCardId
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

/**
 * 5. MENTOR: Submit Experience (FIXED FOLLOW-UP FLOW)
 * FIX: Simple text for follow-ups, No AI transformation
 */
router.post('/mentor/submit-experience', protect, async (req, res) => {
  try {
    const { questionId, rawExperience } = req.body;
// ... (existing code, I just need to find where to insert)

    console.log('DEBUG: Received rawExperience:', rawExperience);
    const question = await Question.findOne({ _id: questionId, selectedMentorId: req.user.userId });
    if (!question) return res.status(404).json({ success: false, error: 'Unauthorized or question not found' });

    // 🚫 Prevent AnswerCard creation for follow-ups
    if (question.isFollowUp && question.parentQuestionId) {
      // 🚀 SIMPLE FOLLOW-UP: Direct text injection to parent card
      const parentCard = await AnswerCard.findOne({ questionId: question.parentQuestionId });
      if (!parentCard) return res.status(404).json({ success: false, error: 'Parent AnswerCard not found' });
      const followUpIndex = parentCard.followUpAnswers.findIndex(
        fu => fu.questionId?.toString() === questionId.toString()
      );
      if (followUpIndex !== -1) {
        // 🔥 Save as object to match schema, fallback if situation is missing
        let mainAnswer = '';
        if (rawExperience) {
          if (typeof rawExperience === 'object') {
            mainAnswer = rawExperience.situation || rawExperience.mainAnswer || '';
          } else if (typeof rawExperience === 'string') {
            mainAnswer = rawExperience;
          }
        }
        parentCard.followUpAnswers[followUpIndex].answerContent = { mainAnswer };
        parentCard.followUpAnswers[followUpIndex].answeredAt = new Date();
      } else {
        return res.status(404).json({ success: false, error: 'Follow-up entry not found in parent card' });
      }
      await parentCard.save();
      question.status = 'delivered';
        // 🚫 Do NOT create MentorExperience or AnswerCard for follow-ups
        // question.answerCardId = undefined; // Ensure no new card is linked
    } else {
      // Main Question: Full AI transformation for Roadmap/Mistakes
      // Debug log for what will be saved
      console.log('DEBUG: Saving MentorExperience with:', { questionId, mentorId: req.user.userId, rawExperience });
      const mentorExperience = new MentorExperience({ questionId, mentorId: req.user.userId, rawExperience });
      await mentorExperience.save();

      const answerCard = await atyantEngine.transformToAnswerCard(mentorExperience, question);
      question.answerCardId = answerCard._id; // Essential Linking Fix
      question.status = 'delivered';
    }

    await question.save();
    const student = await User.findById(question.userId);
    if (student) await sendUserAnswerReadyNotification(student.email, student.name, question.questionText, !!question.isFollowUp);

    res.json({ success: true, message: 'Delivered successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * 6. SHARED: History, Feedback, Follow-up Submission
 */
router.get('/my-questions', protect, async (req, res) => {
  try {
    const questions = await Question.find({ userId: req.user.userId, isFollowUp: { $ne: true } })
      .sort({ createdAt: -1 }).populate('answerCardId');
    res.json({
      success: true,
      questions: questions.map(q => ({
        id: q._id,
        text: q.questionText,
        status: q.status,
        hasAnswer: !!q.answerCardId,
        createdAt: q.createdAt || null,
        followUpCount: Array.isArray(q.followUpQuestions) ? q.followUpQuestions.length : 0
      }))
    });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.post('/answer-feedback', protect, async (req, res) => {
  const { answerCardId, helpful, rating, comment } = req.body;
  await AnswerCard.findByIdAndUpdate(answerCardId, { 
      'userFeedback.helpful': helpful, 
      'userFeedback.rating': rating, 
      'userFeedback.comment': comment 
  });
  res.json({ success: true });
});

router.post('/submit-follow-up', protect, async (req, res) => {
  try {
    const { answerCardId, followUpText } = req.body;
    const answerCard = await AnswerCard.findById(answerCardId);
    if (!answerCard || answerCard.followUpCount >= 2) {
      return res.status(400).json({ success: false, error: 'Limit reached' });
    }

    // 🚀 THE FIX: Original Mentor ko bina match kiye pakdein
    const originalQuestion = await Question.findById(answerCard.questionId);
    const targetMentorId = originalQuestion.selectedMentorId;

    // Check if a follow-up with same text, user, and parent already exists
    let followUpQ = await Question.findOne({
      userId: req.user.userId,
      questionText: followUpText,
      isFollowUp: true,
      parentQuestionId: originalQuestion._id
    });
    if (!followUpQ) {
      followUpQ = new Question({
        userId: req.user.userId,
        questionText: followUpText,
        isFollowUp: true,
        parentQuestionId: originalQuestion._id,
        selectedMentorId: targetMentorId, // 🔥 Direct Assignment
        status: 'mentor_assigned'
      });
      await followUpQ.save();
    }

    // Remove all previous entries for this follow-up QID
    answerCard.followUpAnswers = answerCard.followUpAnswers.filter(fu => fu.questionId?.toString() !== followUpQ._id.toString());
    // Add the latest (single) entry
    answerCard.followUpAnswers.push({
      questionText: followUpText,
      questionId: followUpQ._id,
      askedAt: new Date()
    });
    // Set followUpCount to unique QIDs (max 2)
    answerCard.followUpCount = Math.min(answerCard.followUpAnswers.length, 2);
    await answerCard.save();

    // Mentor ko notification bhejein (Direct)
    const mentor = await User.findById(targetMentorId);
    if (mentor) await sendMentorNewQuestionNotification(mentor.email, mentor.name, followUpText);

    res.json({ success: true, originalQuestionId: originalQuestion._id });
  } catch (e) { res.status(500).json({ success: false }); }
});

/**
 * 7. VIEW ANSWER CARD (Public/Shared)
 * Allows viewing an answer card by ID without being the question owner.
 */
router.get('/answer-card/:answerCardId', protect, async (req, res) => {
  try {
    const { answerCardId } = req.params;
    
    const answerCard = await AnswerCard.findById(answerCardId)
      .populate('mentorId', 'name username bio expertise profileImage ratings');
      
    if (!answerCard) {
      return res.status(404).json({ success: false, error: 'Answer card not found' });
    }

    const question = await Question.findById(answerCard.questionId).select('questionText');
    
    // Format similar to question-status response
    const formattedAnswer = {
      ...answerCard.toObject(),
      id: answerCard._id,
      mentor: answerCard.mentorId,
      content: typeof answerCard.answerContent === 'object'
        ? answerCard.answerContent
        : { mainAnswer: answerCard.answerContent },
      isInstant: true,
      matchScore: answerCard.matchScore || 100
    };

    res.json({
      success: true,
      question: { 
        id: question ? question._id : null, 
        text: question ? question.questionText : 'Original question details unavailable', 
        status: 'delivered' 
      },
      answerCard: formattedAnswer
    });
  } catch (error) {
    console.error('Error fetching answer card:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch answer card' });
  }
});

export default router;