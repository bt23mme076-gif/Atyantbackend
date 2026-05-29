import Notification from '../models/Notification.js';

class NotificationService {
  // Create notification
  async createNotification({ userId, type, title, message, link, metadata = {} }) {
    try {
      const notification = new Notification({
        userId,
        type,
        title,
        message,
        link,
        metadata
      });
      await notification.save();
      
      // TODO: Emit socket event for real-time update
      // io.to(userId).emit('new_notification', notification);
      
      console.log(`✅ Notification created for user ${userId}: ${type}`);
      return notification;
    } catch (error) {
      console.error('❌ Create notification error:', error);
      return null;
    }
  }

  // Get user notifications
  async getUserNotifications(userId, limit = 20, skip = 0) {
    try {
      const notifications = await Notification.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();
      
      return notifications;
    } catch (error) {
      console.error('❌ Get notifications error:', error);
      return [];
    }
  }

  // Get unread count
  async getUnreadCount(userId) {
    try {
      const count = await Notification.countDocuments({ userId, isRead: false });
      return count;
    } catch (error) {
      console.error('❌ Get unread count error:', error);
      return 0;
    }
  }

  // Mark as read
  async markAsRead(notificationId, userId) {
    try {
      await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { isRead: true }
      );
      return true;
    } catch (error) {
      console.error('❌ Mark as read error:', error);
      return false;
    }
  }

  // Mark all as read
  async markAllAsRead(userId) {
    try {
      await Notification.updateMany(
        { userId, isRead: false },
        { isRead: true }
      );
      return true;
    } catch (error) {
      console.error('❌ Mark all as read error:', error);
      return false;
    }
  }

  // Delete notification
  async deleteNotification(notificationId, userId) {
    try {
      await Notification.findOneAndDelete({ _id: notificationId, userId });
      return true;
    } catch (error) {
      console.error('❌ Delete notification error:', error);
      return false;
    }
  }

  // Helper: Create question assigned notification
  async notifyQuestionAssigned(mentorId, questionText, questionId) {
    return this.createNotification({
      userId: mentorId,
      type: 'question_assigned',
      title: '🎯 New Question Assigned',
      message: questionText.substring(0, 100) + (questionText.length > 100 ? '...' : ''),
      link: '/mentor-dashboard',
      metadata: { questionId }
    });
  }

  // Helper: Create answer ready notification
  async notifyAnswerReady(userId, questionText, questionId) {
    return this.createNotification({
      userId,
      type: 'answer_ready',
      title: '✅ Your Answer is Ready!',
      message: questionText.substring(0, 100) + (questionText.length > 100 ? '...' : ''),
      link: '/my-questions',
      metadata: { questionId }
    });
  }

  // Helper: Create booking confirmation notification
  async notifyBookingConfirmed(userId, serviceTitle, bookingId) {
    return this.createNotification({
      userId,
      type: 'booking_confirmed',
      title: '✅ Booking Confirmed',
      message: `Your booking for "${serviceTitle}" has been confirmed!`,
      link: '/my-bookings',
      metadata: { bookingId }
    });
  }

  // Helper: Create booking reminder notification
  async notifyBookingReminder(userId, serviceTitle, bookingId, hours) {
    return this.createNotification({
      userId,
      type: hours === 24 ? 'booking_reminder_24h' : 'booking_reminder_1h',
      title: `⏰ Reminder: Session in ${hours} hour${hours > 1 ? 's' : ''}`,
      message: `Your session "${serviceTitle}" starts soon!`,
      link: '/my-bookings',
      metadata: { bookingId }
    });
  }
}

export default new NotificationService();
