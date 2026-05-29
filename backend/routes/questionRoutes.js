import express from 'express';
import protect from '../middleware/authMiddleware.js';
import { questionLimiter } from '../middleware/rateLimiters.js';
import Question from '../models/Question.js';
import User from '../models/User.js';
import { sendMentorNewQuestionNotification } from '../utils/emailNotifications.js';
import notificationService from '../utils/notificationService.js';
import atyantEngine from '../services/AtyantEngine.js';
import Mentor from '../models/Mentor.js';
import { getQuestionEmbedding } from '../services/AIService.js';
import { getRedditStats } from '../utils/redditStats.js';


const router = express.Router();

/**
 * STEP 2: Check Profile & Credits
 * GET /api/questions/check-eligibility
 */
router.get('/check-eligibility', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const profileStrength = user.calculateProfileStrength();
    const isProfileComplete = profileStrength >= 70; // Minimum 70% required
    
    const missingFields = [];
    if (!user.username) missingFields.push('Username');
    if (!user.bio) missingFields.push('Bio');
    if (!user.education || user.education.length === 0) missingFields.push('Education');
    if (!user.interests || user.interests.length === 0) missingFields.push('Interests');
    
    res.json({
      success: true,
      isProfileComplete,
      profileStrength,
      credits: user.credits || 0, // Question credits
      messageCredits: user.messageCredits || 0, // Chat credits
      missingFields,
      needsUpgrade: (user.credits || 0) === 0
    });
  } catch (error) {
    console.error('❌ Eligibility check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check eligibility' 
    });
  }
});

/**
 * STEP 3: Preview Mentor Match
 * POST /api/questions/preview-match
 */
router.post('/preview-match', questionLimiter, protect, async (req, res) => {
  try {
    const { title, description, category } = req.body;
    
    if (!title || !description) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title and description required' 
      });
    }
    
    // Extract keywords for matching
    const keywords = atyantEngine.extractBetterKeywords(description);
    const questionCategory = req.body.category || null;
    
    // 🔥 TRY VECTOR SEMANTIC SEARCH FIRST
    let instantMatch = null;
    try {
      console.log('🔍 Step 1: Generating embedding for question...');
      const vector = await getQuestionEmbedding(description);
      
      if (vector && vector.length > 0) {
        console.log(`✅ Embedding generated: ${vector.length} dimensions`);
        console.log('🔍 Step 2: Searching for similar answers in vector database...');
        
        instantMatch = await atyantEngine.findBestSemanticMatch(
          req.user.userId, 
          vector, 
          description
        );
        
        if (instantMatch) {
          console.log('⚡ INSTANT ANSWER FOUND!');
          console.log(`   Mentor: ${instantMatch.mentorProfile?.username}`);
          console.log(`   Match Score: ${(instantMatch.finalScore * 100).toFixed(1)}%`);
        } else {
          console.log('❌ No instant answer found in vector database');
          console.log('   Reason: No AnswerCards with high enough similarity (>88%)');
        }
      } else {
        console.log('❌ Embedding generation failed - vector is empty');
      }
    } catch (err) {
      console.log('⚠️ Vector search error:', err.message);
      console.log('   Falling back to live mentor routing...');
    }
    
    // Reddit stats fetch karo (parallel)
    const redditStats = await getRedditStats(description);

    // If instant match found, return it
    if (instantMatch) {
      return res.json({
        success: true,
        mentorFound: true,
        instantAnswer: true,
        answerCardId: instantMatch._id,
        originalQuestionId: instantMatch.questionId,
        mentor: {
          id: instantMatch.mentorProfile._id,
          name: instantMatch.mentorProfile.name || instantMatch.mentorProfile.username,
          bio: instantMatch.mentorProfile.bio,
          expertise: instantMatch.mentorProfile.expertise,
          profileImage: instantMatch.mentorProfile.profilePicture,
          matchPercentage: Math.round(instantMatch.finalScore * 100)
        },
        answerPreview: (instantMatch.answerContent?.mainAnswer || 
          (typeof instantMatch.answerContent === 'string' ? instantMatch.answerContent : 'This answer is being generated for you.'))
          .substring(0, 200) + '...',
        redditStats: redditStats
      });
    }
    
    // 🔥 FALLBACK TO LIVE MENTOR ROUTING
    const topMentors = await atyantEngine.findTopMentors(req.user.userId, keywords, questionCategory, 3);
    
    if (!topMentors || topMentors.length === 0) {
      // Fallback: Return real Atyant Engine mentor from DB
      const atyantMentor = await Mentor.findOne({ username: 'Atyant Engine' });
      if (atyantMentor) {
        return res.json({
          success: true,
          mentorFound: false,
          mentors: [{
            id: atyantMentor._id,
            name: atyantMentor.username,
            bio: atyantMentor.bio,
            profileImage: atyantMentor.profilePicture,
            expertise: atyantMentor.expertise,
            matchPercentage: 100,
            isRecommended: true
          }],
          message: 'No mentor match found. Your question will be answered by Atyant Engine.',
          redditStats: redditStats
        });
      } else {
        return res.json({
          success: true,
          mentorFound: false,
          mentors: [],
          message: 'No mentor match found. We will find one after submission.',
          redditStats: redditStats
        });
      }
    }
    
    res.json({
      success: true,
      mentorFound: true,
      instantAnswer: false,
      mentors: topMentors.map((m, index) => ({
        id: m._id,
        name: m.name || m.username,
        bio: m.bio,
        expertise: m.expertise,
        profileImage: m.profilePicture,
        matchPercentage: m.matchScore || 85,
        isRecommended: index === 0 // First mentor is recommended
      })),
      mentor: { // Keep backward compatibility
        id: topMentors[0]._id,
        name: topMentors[0].name || topMentors[0].username,
        bio: topMentors[0].bio,
        expertise: topMentors[0].expertise,
        profileImage: topMentors[0].profilePicture,
        matchPercentage: topMentors[0].matchScore || 85
      },
      redditStats: redditStats
    });
  } catch (error) {
    console.error('❌ Mentor preview error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to find mentor match' 
    });
  }
});

/**
 * STEP 4: AI Quality Check
 * POST /api/questions/quality-check
 */
router.post('/quality-check', questionLimiter, protect, async (req, res) => {
  try {
    const { title, description } = req.body;
    
    let qualityScore = 0;
    const issues = [];
    
    // Length check
    if (description.length < 50) {
      issues.push('Question is too short. Add more details.');
      qualityScore += 20;
    } else if (description.length < 100) {
      qualityScore += 50;
    } else {
      qualityScore += 70;
    }
    
    // Vague words detection
    const vagueWords = ['help', 'tips', 'advice', 'guidance', 'how', 'what'];
    const wordCount = description.split(/\s+/).length;
    const vagueCount = vagueWords.filter(word => 
      description.toLowerCase().includes(word)
    ).length;
    
    if (vagueCount / wordCount > 0.3) {
      issues.push('Question seems vague. Be more specific about your situation.');
      qualityScore -= 20;
    } else {
      qualityScore += 30;
    }
    
    // Question marks check
    if (!description.includes('?')) {
      issues.push('Add a clear question mark to improve clarity.');
      qualityScore -= 10;
    }
    
    // Context keywords
    const contextWords = ['currently', 'working on', 'struggling with', 'tried', 'background'];
    const hasContext = contextWords.some(word => description.toLowerCase().includes(word));
    
    if (hasContext) {
      qualityScore += 10;
    } else {
      issues.push('Add context about your current situation.');
    }
    
    qualityScore = Math.max(0, Math.min(100, qualityScore));
    
    res.json({
      success: true,
      qualityScore,
      issues,
      needsImprovement: qualityScore < 60
    });
  } catch (error) {
    console.error('❌ Quality check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check question quality' 
    });
  }
});

/**
 * STEP 8: Final Submission
 * POST /api/questions/submit
 */
router.post('/submit', questionLimiter, protect, async (req, res) => {
  try {
    const { title, description, category, reason, qualityScore, mentorId } = req.body;
    
    // Validate required fields
    if (!title || !description || !category) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title, description, and category are required' 
      });
    }
    
    // Check user credits
    const user = await User.findById(req.user.userId);
    if (user.credits <= 0) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient credits. Please upgrade.' 
      });
    }
    
    // Extract keywords
    const keywords = atyantEngine.extractBetterKeywords(description);
    
    // 🔥 TRY VECTOR SEARCH FIRST FOR INSTANT ANSWER
    let instantMatch = null;
    let vector = null;
    
    try {
      console.log('🔍 [SUBMIT] Step 1: Generating embedding for question...');
      vector = await getQuestionEmbedding(description);
      
      if (vector && vector.length > 0) {
        console.log(`✅ [SUBMIT] Embedding generated: ${vector.length} dimensions`);
        console.log('🔍 [SUBMIT] Step 2: Searching for instant answer...');
        
        instantMatch = await atyantEngine.findBestSemanticMatch(
          req.user.userId,
          vector,
          description
        );
        
        if (instantMatch) {
          console.log('⚡ [SUBMIT] INSTANT ANSWER FOUND - Creating instant answer question');
          console.log(`   Mentor: ${instantMatch.mentorProfile?.username}`);
          console.log(`   Match Score: ${(instantMatch.finalScore * 100).toFixed(1)}%`);
        } else {
          console.log('ℹ️ [SUBMIT] No instant answer found, will route to live mentor');
        }
      }
    } catch (err) {
      console.log('⚠️ [SUBMIT] Vector search failed:', err.message);
    }
    
    // Respect client's preference: if they asked to force live routing (e.g. they
    // saw an instant answer but explicitly chose to continue), skip instant branch.
    const { forceLive } = req.body || {};

    // 🔥 IF INSTANT MATCH FOUND - Create question with instant answer (unless forced live)
    if (instantMatch && !forceLive) {
      const question = new Question({
        userId: req.user.userId,
        title,
        questionText: description,
        category,
        reason: reason || '',
        qualityScore: qualityScore || 0,
        keywords,
        selectedMentorId: instantMatch.mentorProfile._id,
        answerCardId: instantMatch._id,
        status: 'answered_instantly',
        isInstant: true,
        matchScore: Math.round(instantMatch.finalScore * 100),
        matchMethod: 'vector_semantic'
      });
      
      await question.save();
      
      // Deduct credit
      await User.findByIdAndUpdate(req.user.userId, {
        $inc: { credits: -1 }
      });
      
      console.log('✅ [SUBMIT] Instant answer delivered, credit deducted');
      
      return res.json({
        success: true,
        instantAnswer: true,
        questionId: question._id,
        answerCardId: instantMatch._id,
        message: 'Great news! We found an instant answer from a mentor who solved the same problem!'
      });
    }
    
    // 🔥 NO INSTANT MATCH - Create question and route to live mentor
    console.log('📋 [SUBMIT] Creating question for live mentor routing...');
    
    // Create question
    const question = new Question({
      userId: req.user.userId,
      title,
      questionText: description, // Map to existing field
      category,
      reason: reason || '',
      qualityScore: qualityScore || 0,
      keywords,
      selectedMentorId: mentorId || null,
      status: 'submitted',
      matchMethod: 'live_routing'
    });
    
    // If no mentor provided, find best match
    if (!mentorId) {
      const bestMentor = await atyantEngine.findBestMentor(req.user.userId, keywords, category);
      
      if (bestMentor) {
        question.selectedMentorId = bestMentor._id;
        question.matchPercentage = bestMentor.matchScore || 85;
        question.status = 'mentor_assigned';
        
        // Increment mentor's active questions if they have that field
        await User.findByIdAndUpdate(bestMentor._id, { 
          $inc: { activeQuestions: 1 } 
        });
      }
    } else {
      question.status = 'mentor_assigned';
      await User.findByIdAndUpdate(mentorId, { 
        $inc: { activeQuestions: 1 } 
      });
    }
    
    await question.save();
    
    // Deduct credit
    await User.findByIdAndUpdate(req.user.userId, { $inc: { credits: -1 } });

    // Notify assigned mentor (if any)
    if (question.selectedMentorId) {
      try {
        const mentor = await User.findById(question.selectedMentorId).select('email username name');
        if (mentor && mentor.email) {
          // Send email
          await sendMentorNewQuestionNotification(
            mentor.email,
            mentor.username || mentor.name || 'Mentor',
            question.questionText,
            question.keywords || []
          );
          
          // Create in-app notification
          await notificationService.notifyQuestionAssigned(
            question.selectedMentorId,
            question.questionText,
            question._id
          );
        }
      } catch (notifyErr) {
        console.error('Error sending mentor new-question notification:', notifyErr);
      }
    }
    
    res.json({
      success: true,
      questionId: question._id,
      creditsRemaining: user.credits,
      message: 'Question submitted successfully'
    });
  } catch (error) {
    console.error('❌ Question submission error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to submit question' 
    });
  }
});

/**
 * Edit Question (within 5 minutes only)
 * PUT /api/questions/:id
 */
router.put('/:id', protect, async (req, res) => {
  try {
    const question = await Question.findOne({
      _id: req.params.id,
      userId: req.user.userId
    });
    
    if (!question) {
      return res.status(404).json({ 
        success: false, 
        error: 'Question not found' 
      });
    }
    
    if (!question.checkEditable()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Edit period expired (5 minutes limit)' 
      });
    }
    
    const { title, description, category, reason } = req.body;
    
    if (title) question.title = title;
    if (description) question.questionText = description;
    if (category) question.category = category;
    if (reason !== undefined) question.reason = reason;
    
    question.lastEditedAt = new Date();
    
    // Re-extract keywords if description changed
    if (description) {
      question.keywords = atyantEngine.extractBetterKeywords(description);
    }
    
    await question.save();
    
    res.json({
      success: true,
      question,
      message: 'Question updated successfully'
    });
  } catch (error) {
    console.error('❌ Question edit error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update question' 
    });
  }
});

/**
 * Get User's Question List
 * GET /api/questions/my-questions
 */
router.get('/my-questions', protect, async (req, res) => {
  try {
    const questions = await Question.find({ userId: req.user.userId })
      .populate('selectedMentorId', 'name username profilePicture expertise')
      .populate('answerCardId')
      .sort({ createdAt: -1 });
    
    const questionsWithEditability = questions.map(q => ({
      ...q.toObject(),
      isEditable: q.checkEditable()
    }));
    
    res.json({
      success: true,
      questions: questionsWithEditability
    });
  } catch (error) {
    console.error('❌ Questions fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch questions' 
    });
  }
});

/**
 * Get User's Dashboard (Questions + Bookings Combined)
 * GET /api/questions/my-dashboard
 */
router.get('/my-dashboard', protect, async (req, res) => {
  try {
    // Import Booking model
    const Booking = (await import('../models/Booking.js')).default;
    const Service = (await import('../models/Service.js')).default;
    
    // Fetch questions
    const questions = await Question.find({ userId: req.user.userId })
      .populate('selectedMentorId', 'name username profilePicture expertise')
      .populate('answerCardId')
      .sort({ createdAt: -1 });
    
    // Fetch bookings
    const bookings = await Booking.find({ userId: req.user.userId })
      .populate('mentorId', 'name username profilePicture')
      .populate('serviceId', 'title type duration price')
      .sort({ createdAt: -1 });
    
    // Transform questions into dashboard items
    const questionItems = questions.map(q => ({
      type: 'question',
      _id: q._id,
      title: q.title || q.questionText || q.text,
      description: q.questionText || q.text,
      status: q.status,
      category: q.category,
      mentor: q.selectedMentorId ? {
        _id: q.selectedMentorId._id,
        name: q.selectedMentorId.name || q.selectedMentorId.username,
        username: q.selectedMentorId.username,
        profilePicture: q.selectedMentorId.profilePicture
      } : null,
      matchPercentage: q.matchPercentage,
      followUpCount: q.followUpCount || 0,
      hasAnswer: !!q.answerCardId,
      createdAt: q.createdAt,
      isEditable: q.checkEditable ? q.checkEditable() : false,
      // Check if this question has an associated booking
      booking: null // Will be populated below
    }));
    
    // Transform bookings into dashboard items
    const bookingItems = bookings.map(b => ({
      type: 'booking',
      _id: b._id,
      title: b.serviceId?.title || 'Service Booking',
      service: {
        _id: b.serviceId?._id,
        title: b.serviceId?.title,
        type: b.serviceType,
        duration: b.serviceId?.duration,
        price: b.serviceId?.price
      },
      mentor: b.mentorId ? {
        _id: b.mentorId._id,
        name: b.mentorId.name || b.mentorId.username,
        username: b.mentorId.username,
        profilePicture: b.mentorId.profilePicture
      } : null,
      scheduledAt: b.scheduledAt,
      status: b.status,
      meetingLink: b.meetingLink,
      amount: b.amount,
      notes: b.notes,
      createdAt: b.createdAt,
      questionId: b.questionId // Link to question if exists
    }));
    
    // Link bookings to questions
    bookingItems.forEach(booking => {
      if (booking.questionId) {
        const question = questionItems.find(q => q._id.toString() === booking.questionId.toString());
        if (question) {
          question.booking = {
            _id: booking._id,
            serviceType: booking.service.type,
            scheduledAt: booking.scheduledAt,
            meetingLink: booking.meetingLink,
            status: booking.status,
            amount: booking.amount
          };
        }
      }
    });
    
    // Combine and sort by date
    const allItems = [...questionItems, ...bookingItems].sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    
    res.json({
      success: true,
      items: allItems,
      stats: {
        totalQuestions: questionItems.length,
        totalBookings: bookingItems.length,
        upcomingCalls: bookingItems.filter(b => 
          b.scheduledAt && new Date(b.scheduledAt) > new Date() && b.status === 'confirmed'
        ).length
      }
    });
  } catch (error) {
    console.error('❌ Dashboard fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard data' 
    });
  }
});

export default router;
