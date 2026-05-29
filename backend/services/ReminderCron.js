import cron from 'node-cron';
import Booking from '../models/Booking.js';
import BookingService from './BookingService.js';

class ReminderCron {
  start() {
    // Run every hour to check for reminders
    cron.schedule('0 * * * *', async () => {
      console.log('🔔 Running reminder check...');
      await this.checkAndSendReminders();
    });

    console.log('✅ Reminder cron job started');
  }

  async checkAndSendReminders() {
    try {
      const now = new Date();
      const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);

      // Find bookings that need 24h reminder
      const bookingsFor24h = await Booking.find({
        status: 'confirmed',
        scheduledAt: {
          $gte: in24Hours,
          $lte: new Date(in24Hours.getTime() + 60 * 60 * 1000) // Within next hour
        },
        'remindersSent.email24h': false
      });

      // Find bookings that need 1h reminder
      const bookingsFor1h = await Booking.find({
        status: 'confirmed',
        scheduledAt: {
          $gte: in1Hour,
          $lte: new Date(in1Hour.getTime() + 60 * 60 * 1000) // Within next hour
        },
        'remindersSent.email1h': false
      });

      // Send 24h reminders
      for (const booking of bookingsFor24h) {
        await BookingService.sendReminder(booking, '24h');
      }

      // Send 1h reminders
      for (const booking of bookingsFor1h) {
        await BookingService.sendReminder(booking, '1h');
      }

      console.log(`✅ Sent ${bookingsFor24h.length} 24h reminders and ${bookingsFor1h.length} 1h reminders`);
    } catch (error) {
      console.error('Reminder cron error:', error);
    }
  }
}

export default new ReminderCron();
