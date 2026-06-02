import express from 'express';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/bookings/my — returns empty list for guests, real data for logged-in users
router.get('/my', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?._id;
    if (!userId) {
      return res.json({ ok: true, upcoming: [], past: [] });
    }
    const now = new Date();
    const bookings = await Booking.find({ userId })
      .sort({ scheduledAt: -1 })
      .lean();

    const upcoming = bookings.filter(
      b => new Date(b.scheduledAt) > now && b.status !== 'cancelled'
    );
    const past = bookings.filter(
      b => new Date(b.scheduledAt) <= now || b.status === 'completed'
    );

    res.json({ ok: true, upcoming, past });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bookings/book — book a new session
// Body: { mentorId, date, time, topic, serviceType, amount }
router.post('/book', protect, async (req, res) => {
  try {
    const { mentorId, date, time, topic, serviceType, amount } = req.body;

    if (!date || !time) {
      return res.status(400).json({ ok: false, error: 'date and time are required' });
    }

    if (!mentorId) {
      return res.status(400).json({ ok: false, error: 'mentorId is required' });
    }

    const scheduledAt = new Date(`${date} ${time}`);
    if (isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid date/time format' });
    }

    if (scheduledAt < new Date()) {
      return res.status(400).json({ ok: false, error: 'Cannot book a session in the past' });
    }

    // Fetch mentor details
    const mentor = await User.findById(mentorId).lean();
    if (!mentor) {
      return res.status(404).json({ ok: false, error: 'Mentor not found' });
    }

    // Fetch active user details to populate required booking schema details
    const activeUser = await User.findById(req.user.userId).lean();
    if (!activeUser) {
      return res.status(404).json({ ok: false, error: 'User profile not found' });
    }

    const booking = await Booking.create({
      userId:       req.user.userId,
      mentorId:     mentor._id,
      name:         activeUser.name || activeUser.username || 'Logged In User',
      email:        activeUser.email,
      phone:        activeUser.phone || '',
      serviceType:  serviceType || 'video-call', // Falls back to schema default safe enum
      topic:        topic || 'Career Guidance Session',
      scheduledAt,
      amount:       amount || 0, // Fulfilled required amount field
      status:       'upcoming',
    });

    res.status(201).json({ ok: true, booking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/bookings/:id/cancel — cancel a booking
router.patch('/:id/cancel', protect, async (req, res) => {
  try {
    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { status: 'cancelled', cancelledAt: new Date() },
      { new: true }
    );
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found' });
    res.json({ ok: true, booking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/bookings/:id/complete — mark a booking complete (mentor/admin)
router.patch('/:id/complete', protect, async (req, res) => {
  try {
    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id },
      { status: 'completed', completedAt: new Date() },
      { new: true }
    );
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found' });
    res.json({ ok: true, booking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;