import cron from 'node-cron';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { sendSessionReminderEmails } from '../utils/emailService.js';
import { localizeMeetLink } from '../utils/frontendUrl.js';

class ReminderCron {
  start() {
    // Run every hour, on the hour, to check for sessions needing a reminder.
    cron.schedule('0 * * * *', async () => {
      console.log('🔔 Running reminder check...');
      await this.checkAndSendReminders();
    });

    console.log('✅ Reminder cron job started');
  }

  async checkAndSendReminders() {
    try {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in1h  = new Date(now.getTime() +      60 * 60 * 1000);
      const hour  = 60 * 60 * 1000;

      // Sessions whose start falls in the next [24h, 25h) window — send 24h reminder.
      const for24h = await Session.find({
        status: 'upcoming',
        scheduledAt: { $gte: in24h, $lt: new Date(in24h.getTime() + hour) },
        'remindersSent.email24h': { $ne: true },
      }).lean();

      // Sessions whose start falls in the next [1h, 2h) window — send 1h reminder.
      const for1h = await Session.find({
        status: 'upcoming',
        scheduledAt: { $gte: in1h, $lt: new Date(in1h.getTime() + hour) },
        'remindersSent.email1h': { $ne: true },
      }).lean();

      for (const s of for24h) await this.sendOne(s, '24h');
      for (const s of for1h)  await this.sendOne(s, '1h');

      console.log(`✅ Sent ${for24h.length} 24h reminders and ${for1h.length} 1h reminders`);
    } catch (error) {
      console.error('Reminder cron error:', error);
    }
  }

  // Email both parties for one session, then flag it so it never re-sends.
  async sendOne(session, type) {
    try {
      const [student, mentor] = await Promise.all([
        User.findById(session.userId).select('email name username').lean(),
        session.mentorId ? User.findById(session.mentorId).select('email name username').lean() : null,
      ]);
      if (!student?.email) return; // nobody to remind

      const label = type === '24h' ? '24 hours' : '1 hour';
      await sendSessionReminderEmails({
        studentEmail: student.email,
        studentName:  student.name || student.username,
        mentorEmail:  mentor?.email,
        mentorName:   mentor?.name || mentor?.username || session.mentorName,
        scheduledAt:  session.scheduledAt,
        durationMin:  session.durationMin,
        topic:        session.topic,
        meetLink:     localizeMeetLink(session.meetingLink),
        label,
      });

      const field = type === '24h' ? 'remindersSent.email24h' : 'remindersSent.email1h';
      await Session.findByIdAndUpdate(session._id, { $set: { [field]: true } });
      console.log(`📧 Sent ${label} reminder for session ${session._id} to ${student.email}${mentor?.email ? ' + ' + mentor.email : ''}`);
    } catch (err) {
      console.error(`Reminder send error (${type}) for session ${session?._id}:`, err.message);
    }
  }
}

export default new ReminderCron();
