import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'question_assigned',    // Mentor: New question assigned
      'answer_ready',         // User: Answer is ready
      'booking_confirmed',    // User/Mentor: Booking confirmed
      'booking_reminder_24h', // User: 24h reminder
      'booking_reminder_1h',  // User: 1h reminder
      'new_message',          // Chat message
      'payment_success',      // Payment successful
      'credit_added'          // Credits added
    ],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  link: {
    type: String, // Where to redirect when clicked
    default: null
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed, // Extra data (questionId, bookingId, etc.)
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Index for efficient queries
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', NotificationSchema);
