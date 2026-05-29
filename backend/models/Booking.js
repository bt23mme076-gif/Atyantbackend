import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Optional: Link to question if booking was made from a question
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question',
    index: true
  },
  
  // Payment information
  razorpayPaymentId: {
    type: String,
    required: true,
    index: true
  },
  
  razorpayOrderId: {
    type: String,
    required: true
  },
  
  scheduledAt: {
    type: Date,
    required: function() {
      return this.serviceType === 'video-call' || this.serviceType === 'audio-call';
    },
    index: true
  },
  
  serviceType: {
    type: String,
    enum: ['video-call', 'audio-call', 'chat', 'answer-card'],
    required: true
  },
  
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled', 'refunded'],
    default: 'confirmed',
    index: true
  },
  
  meetingLink: {
    type: String
  },
  
  meetingPlatform: {
    type: String,
    enum: ['zoom', 'google-meet', 'platform'],
    default: 'google-meet'
  },
  
  notes: {
    type: String,
    maxlength: 500
  },
  
  amount: {
    type: Number,
    required: true
  },
  
  // Google Calendar Integration
  googleCalendarEventId: {
    type: String
  },
  
  // Reminders
  remindersSent: {
    email24h: { type: Boolean, default: false },
    email1h: { type: Boolean, default: false },
    sms1h: { type: Boolean, default: false }
  },
  
  // Rescheduling
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },
  
  rescheduledTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },
  
  rescheduleCount: {
    type: Number,
    default: 0
  },
  
  // Cancellation
  completedAt: {
    type: Date
  },
  
  cancelledAt: {
    type: Date
  },
  
  cancellationReason: {
    type: String
  },
  
  cancelledBy: {
    type: String,
    enum: ['user', 'mentor', 'admin']
  },
  
  refundAmount: {
    type: Number,
    default: 0
  },
  
  refundStatus: {
    type: String,
    enum: ['none', 'pending', 'processed', 'failed'],
    default: 'none'
  }
  
}, { timestamps: true });

bookingSchema.index({ mentorId: 1, status: 1, scheduledAt: -1 });
bookingSchema.index({ userId: 1, status: 1, scheduledAt: -1 });
bookingSchema.index({ scheduledAt: 1, status: 1 });

const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;
