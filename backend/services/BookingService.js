import Booking from '../models/Booking.js';
import User from '../models/User.js';

class BookingService {

  async sendReminder(booking, type) {
    try {
      const [user, mentor] = await Promise.all([
        User.findById(booking.userId).select('email name username').lean(),
        User.findById(booking.mentorId).select('email name username').lean()
      ]);

      if (!user || !mentor) return;

      const label = type === '24h' ? '24 hours' : '1 hour';
      console.log(`📧 Sending ${label} reminder to ${user.email} for booking ${booking._id}`);

      // Mark reminder as sent
      const field = type === '24h' ? 'remindersSent.email24h' : 'remindersSent.email1h';
      await Booking.findByIdAndUpdate(booking._id, { $set: { [field]: true } });

    } catch (err) {
      console.error(`Reminder send error (${type}):`, err.message);
    }
  }

  async rescheduleBooking(bookingId, newDate, newTime, userId) {
    const scheduledAt = new Date(`${newDate}T${newTime}:00+05:30`);
    if (isNaN(scheduledAt.getTime())) throw new Error('Invalid date/time format');
    if (scheduledAt <= new Date()) throw new Error('Cannot reschedule to a past time');

    const existing = await Booking.findOne({ _id: bookingId, userId });  // userId matches req.user.userId
    if (!existing) throw new Error('Booking not found or unauthorized');

    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      {
        scheduledAt,
        status: 'confirmed',
        rescheduledFrom: existing.scheduledAt,
        $inc: { rescheduleCount: 1 },
        'remindersSent.email24h': false,
        'remindersSent.email1h': false,
      },
      { new: true }
    );
    return booking;
  }

  async cancelBooking(bookingId, userId, reason) {
    const booking = await Booking.findOne({ _id: bookingId, userId });  // same fix
    if (!booking) throw new Error('Booking not found or unauthorized');

    const hoursUntil = (new Date(booking.scheduledAt) - new Date()) / (1000 * 60 * 60);
    const refundPercentage = hoursUntil >= 24 ? 100 : hoursUntil >= 2 ? 50 : 0;

    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.cancelReason = reason || '';
    await booking.save();

    return { booking, refundAmount: (booking.amount * refundPercentage) / 100, refundPercentage };
  }
}

export default new BookingService();
