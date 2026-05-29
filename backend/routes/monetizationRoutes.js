import express from 'express';
import mongoose from 'mongoose';
import protect from '../middleware/authMiddleware.js';
import Service from '../models/Service.js';
import Booking from '../models/Booking.js';
import Availability from '../models/Availability.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';

const router = express.Router();

// ─────────────────────────────────────────────
//  SERVICES MANAGEMENT
// ─────────────────────────────────────────────

// Get mentor's services
router.get('/services', protect, async (req, res) => {
  try {
    const services = await Service.find({ 
      mentorId: req.user.userId 
    }).sort({ createdAt: -1 });
    
    res.json({ success: true, services });
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch services' });
  }
});

// Get services by mentor ID (public)
router.get('/services/mentor/:mentorId', async (req, res) => {
  try {
    const mentorId = req.params.mentorId;
    if (!mentorId || !mongoose.Types.ObjectId.isValid(mentorId)) {
      return res.status(400).json({ success: false, error: 'Invalid mentorId' });
    }

    const services = await Service.find({ 
      mentorId,
      isActive: true
    }).sort({ createdAt: -1 });
    
    res.json({ success: true, services });
  } catch (error) {
    console.error('Get mentor services error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch services' });
  }
});

// Create service
router.post('/services', protect, async (req, res) => {
  try {
    if (req.user.role !== 'mentor') {
      return res.status(403).json({ success: false, error: 'Only mentors can create services' });
    }
    
    const service = new Service({
      ...req.body,
      mentorId: req.user.userId
    });
    
    await service.save();
    res.json({ success: true, service });
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({ success: false, error: 'Failed to create service' });
  }
});

// Update service
router.put('/services/:id', protect, async (req, res) => {
  try {
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, mentorId: req.user.userId },
      req.body,
      { new: true }
    );
    
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    
    res.json({ success: true, service });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ success: false, error: 'Failed to update service' });
  }
});

// Delete service
router.delete('/services/:id', protect, async (req, res) => {
  try {
    const service = await Service.findOneAndDelete({
      _id: req.params.id,
      mentorId: req.user.userId
    });
    
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    
    res.json({ success: true, message: 'Service deleted' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete service' });
  }
});

// ─────────────────────────────────────────────
//  BOOKINGS MANAGEMENT
// ─────────────────────────────────────────────

// Get mentor's bookings
router.get('/bookings', protect, async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const query = { mentorId: req.user.userId };
    
    if (status) query.status = status;
    if (from || to) {
      query.scheduledAt = {};
      if (from) query.scheduledAt.$gte = new Date(from);
      if (to) query.scheduledAt.$lte = new Date(to);
    }
    
    const bookings = await Booking.find(query)
      .populate('userId', 'username email profilePicture')
      .populate('serviceId', 'title type duration')
      .sort({ scheduledAt: -1 });
    
    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Update booking status
router.put('/bookings/:id', protect, async (req, res) => {
  try {
    const { status, meetingLink, notes } = req.body;
    
    const booking = await Booking.findOne({
      _id: req.params.id,
      mentorId: req.user.userId
    });
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    if (status) booking.status = status;
    if (meetingLink) booking.meetingLink = meetingLink;
    if (notes) booking.notes = notes;
    
    if (status === 'completed') booking.completedAt = new Date();
    if (status === 'cancelled') booking.cancelledAt = new Date();
    
    await booking.save();
    res.json({ success: true, booking });
  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({ success: false, error: 'Failed to update booking' });
  }
});

// ─────────────────────────────────────────────
//  AVAILABILITY MANAGEMENT
// ─────────────────────────────────────────────

// Get availability
router.get('/availability', protect, async (req, res) => {
  try {
    let availability = await Availability.findOne({ mentorId: req.user.userId });
    
    if (!availability) {
      availability = new Availability({ mentorId: req.user.userId });
      await availability.save();
    }
    
    res.json({ success: true, availability });
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch availability' });
  }
});

// Get availability by mentor ID (public)
router.get('/availability/mentor/:mentorId', async (req, res) => {
  try {
    let availability = await Availability.findOne({ mentorId: req.params.mentorId });
    
    if (!availability) {
      // Return default availability if not set
      availability = {
        timezone: 'Asia/Kolkata',
        weeklySchedule: {},
        blockedDates: [],
        bufferTime: 15
      };
    }
    
    res.json({ success: true, availability });
  } catch (error) {
    console.error('Get mentor availability error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch availability' });
  }
});

// Update availability
router.put('/availability', protect, async (req, res) => {
  try {
    const availability = await Availability.findOneAndUpdate(
      { mentorId: req.user.userId },
      req.body,
      { new: true, upsert: true }
    );
    
    res.json({ success: true, availability });
  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json({ success: false, error: 'Failed to update availability' });
  }
});

// ─────────────────────────────────────────────
//  EARNINGS & ANALYTICS
// ─────────────────────────────────────────────

// Get earnings dashboard
router.get('/earnings', protect, async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(period));
    
    const [earnings, bookingsStats, services] = await Promise.all([
      Payment.aggregate([
        {
          $match: {
            mentorId: req.user.userId,
            status: 'completed',
            createdAt: { $gte: daysAgo }
          }
        },
        {
          $group: {
            _id: null,
            totalEarnings: { $sum: '$amount' },
            totalTransactions: { $sum: 1 }
          }
        }
      ]),
      
      Booking.aggregate([
        {
          $match: {
            mentorId: req.user.userId,
            createdAt: { $gte: daysAgo }
          }
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),
      
      Service.find({ mentorId: req.user.userId, isActive: true })
    ]);
    
    const earningsData = earnings[0] || { totalEarnings: 0, totalTransactions: 0 };
    const bookingsByStatus = {};
    bookingsStats.forEach(stat => {
      bookingsByStatus[stat._id] = stat.count;
    });
    
    res.json({
      success: true,
      earnings: {
        total: earningsData.totalEarnings,
        transactions: earningsData.totalTransactions,
        period: parseInt(period)
      },
      bookings: {
        pending: bookingsByStatus.pending || 0,
        confirmed: bookingsByStatus.confirmed || 0,
        completed: bookingsByStatus.completed || 0,
        cancelled: bookingsByStatus.cancelled || 0
      },
      activeServices: services.length
    });
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch earnings' });
  }
});

// ─────────────────────────────────────────────
//  BOOKING MANAGEMENT (User Side)
// ─────────────────────────────────────────────

// Get user's bookings
router.get('/my-bookings', protect, async (req, res) => {
  try {
    const { status, upcoming } = req.query;
    const query = { userId: req.user.userId };
    
    if (status) query.status = status;
    
    if (upcoming === 'true') {
      query.scheduledAt = { $gte: new Date() };
      query.status = { $in: ['confirmed', 'pending'] };
    }
    
    const bookings = await Booking.find(query)
      .populate('mentorId', 'username name email profilePicture')
      .populate('serviceId', 'title type duration')
      .sort({ scheduledAt: -1 });
    
    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Get my bookings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Reschedule booking
router.post('/bookings/:id/reschedule', protect, async (req, res) => {
  try {
    const { newDate, newTime } = req.body;
    
    const BookingService = (await import('../services/BookingService.js')).default;
    const newBooking = await BookingService.rescheduleBooking(
      req.params.id,
      newDate,
      newTime,
      req.user.userId
    );
    
    res.json({ success: true, booking: newBooking });
  } catch (error) {
    console.error('Reschedule booking error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel booking
router.post('/bookings/:id/cancel', protect, async (req, res) => {
  try {
    const { reason } = req.body;
    
    const BookingService = (await import('../services/BookingService.js')).default;
    const result = await BookingService.cancelBooking(
      req.params.id,
      req.user.userId,
      reason,
      'user'
    );
    
    res.json({ 
      success: true, 
      booking: result.booking,
      refundAmount: result.refundAmount,
      refundPercentage: result.refundPercentage
    });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
