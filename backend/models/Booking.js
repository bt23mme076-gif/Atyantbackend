import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service'
  },
  serviceType: {
    type: String,
    enum: ['video-call', 'audio-call', 'chat', 'review'],
    default: 'video-call'
  },
  scheduledAt: {
    type: Date,
    required: true
  },
  duration: {
    type: Number, // minutes
    default: 30
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled', 'rescheduled'],
    default: 'pending'
  },
  meetingLink: {
    type: String
  },
  amount: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'INR'
  },
  notes: {
    type: String
  },
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question'
  },
  paymentId: {
    type: String
  },
  remindersSent: {
    email24h: { type: Boolean, default: false },
    email1h:  { type: Boolean, default: false }
  },
  completedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelReason: { type: String }
}, {
  timestamps: true
});

bookingSchema.index({ userId: 1, scheduledAt: -1 });
bookingSchema.index({ mentorId: 1, scheduledAt: -1 });
bookingSchema.index({ status: 1, scheduledAt: 1 });

const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;
