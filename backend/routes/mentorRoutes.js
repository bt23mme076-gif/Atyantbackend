import express from 'express';
import mongoose from 'mongoose';
import { LRUCache } from 'lru-cache';
import User from '../models/User.js';
import Message from '../models/Message.js';
import Service from '../models/Service.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();
const isDev  = process.env.NODE_ENV === 'development';

// ─────────────────────────────────────────────
//  MENTOR LIST CACHE
//  🔴 FIX: Use LRU (bounded memory) instead of module-level variable
//  Note: for multi-instance (2+ PM2 workers) this still gives per-process
//  caching which is fine — each process warms independently.
// ─────────────────────────────────────────────
const mentorListCache = new LRUCache({
  max: 1,           // single entry
  ttl: 5 * 60 * 1000  // 5 min
});

// ─────────────────────────────────────────────
//  MENTOR STRATEGY UPDATE
// ─────────────────────────────────────────────
router.post('/update-strategy', protect, async (req, res) => {
  try {
    const { tone, language, hardTruth, timeWaste, roadmap, resumeTip, neverRecommend, permission } = req.body;
    const mentorId = req.user.userId;

    const mentor = await User.findByIdAndUpdate(
      mentorId,
      { $set: { strategy: { tone, language, hardTruth, timeWaste, roadmap, resumeTip, neverRecommend, permission }, isStrategyComplete: true } },
      { new: true, select: 'username strategy' }
    );

    if (!mentor) return res.status(404).json({ error: 'Mentor not found' });
    res.json({ message: 'Strategy saved! Now we can handle your pending questions.' });
  } catch (err) {
    console.error('update-strategy error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─────────────────────────────────────────────
//  GET ALL MENTORS (cached) - UPDATED WITH SERVICES
// ─────────────────────────────────────────────
router.get('/mentors', async (req, res) => {
  try {
    const cached = mentorListCache.get('all');
    if (cached) {
      if (isDev) console.log('✅ Mentor list cache hit');
      return res.json(cached);
    }

    // 1. Mentors fetch karein
    const mentors = await User.find({ role: 'mentor' })
      .select('name username profilePicture profileImage bio city expertise skills isOnline lastActive yearsOfExperience price location rating responseRate companyDomain')
      .sort({ lastActive: -1 })
      .lean();

    // 2. Saari active services fetch karein 
    const allServices = await Service.find({ isActive: true }).lean();

    // 3. Mentors ke saath unki services link karein (Join logic)
    const mentorsWithServices = mentors.map(mentor => {
      const mentorServices = allServices
        .filter(s => s.mentorId.toString() === mentor._id.toString())
        .map(s => s.type); // Example: ['video-call', 'audio-call']

      return {
        ...mentor,
        serviceType: mentorServices[0] || null, // Primary service
        services: mentorServices                // All services list
      };
    });

    // 4. Cache update karein
    mentorListCache.set('all', mentorsWithServices);
    
    if (isDev) console.log(`✅ Fetched ${mentors.length} mentors with services from DB`);
    res.json(mentorsWithServices);

  } catch (error) {
    console.error('GET /mentors error:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
//  GET MENTOR BY ID
// ─────────────────────────────────────────────
router.get('/mentors/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid mentor id' });
    }

    const mentor = await User.findById(id)
      .select('-password -passwordResetToken -passwordResetExpires -verificationToken')
      .lean();

    if (!mentor || mentor.role !== 'mentor') {
      return res.status(404).json({ message: 'Mentor not found' });
    }

    // Fire-and-forget profile view increment
    User.findByIdAndUpdate(req.params.id, { $inc: { profileViews: 1 } })
      .catch(err => console.error('profileViews increment failed:', err.message));

    res.json(mentor);
  } catch (error) {
    console.error('GET /mentors/:id error:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
//  SEARCH MENTORS
// ─────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { q, expertise, city } = req.query;
    const query = { role: 'mentor' };

    if (q) {
      const re = { $regex: q, $options: 'i' };
      query.$or = [{ username: re }, { bio: re }];
    }
    if (expertise) query.expertise = { $in: [expertise] };
    if (city)      query.city      = { $regex: city, $options: 'i' };

    const mentors = await User.find(query)
      .select('username profilePicture bio city expertise skills isOnline rating')
      .limit(50)
      .lean();

    res.json(mentors);
  } catch (error) {
    console.error('GET /search error:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
//  CLEAR MENTOR CACHE (admin)
// ─────────────────────────────────────────────
router.post('/clear-cache', protect, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Unauthorised' });
  }
  mentorListCache.clear();
  res.json({ message: 'Mentor cache cleared' });
});

// ─────────────────────────────────────────────
//  MENTOR STATS
// ─────────────────────────────────────────────
router.get('/stats', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ message: 'Only mentors can access this' });
    }

    const mentorId = req.user.userId;

    const mentor = await User.findById(mentorId)
      .select('profileViews totalChats username')
      .lean();

    if (!mentor) return res.status(404).json({ message: 'Mentor not found' });

    const sevenDaysAgo  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const mentorObjectId = new mongoose.Types.ObjectId(mentorId);

    const [activeConversations] = await Message.aggregate([
      {
        $match: {
          $or: [
            { sender  : mentorObjectId, createdAt: { $gte: sevenDaysAgo } },
            { receiver: mentorObjectId, createdAt: { $gte: sevenDaysAgo } }
          ]
        }
      },
      {
        $group: {
          _id: {
            $cond: [{ $eq: ['$sender', mentorObjectId] }, '$receiver', '$sender']
          }
        }
      },
      { $count: 'total' }
    ]);

    res.json({
      profileViews: mentor.profileViews || 0,
      totalChats  : mentor.totalChats   || 0,
      activeChats : activeConversations?.total || 0
    });
  } catch (error) {
    console.error('GET /stats error:', error.message);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
