import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  // --- Relational Fields ---
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service'
  },

  // --- Guest / Intake Metadata ---
  name: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true, 
    trim: true, 
    lowercase: true 
  },
  phone: { 
    type: String, 
    default: '' 
  },
  
  // --- Session Configuration ---
  serviceType: {
    type: String,
    enum: ['video-call', 'audio-call', 'chat', 'review', 'career-roadmap'],
    default: 'video-call'
  },
  topic: { 
    type: String, 
    default: 'Career Guidance Session' 
  },
  duration: {
    type: Number, 
    default: 30
  },

  // --- User Intake Forms ---
  goals: { 
    type: [String], 
    default: [] 
  },
  brief: { 
    type: String, 
    maxlength: 600, 
    default: '' 
  },

  // --- Scheduling & Logistics ---
  scheduledAt: {
    type: Date,
    required: true,
    index: true
  },
  meetingPlatform: { 
    type: String,
    default: 'google-meet'
  },
  meetingLink: {
    type: String
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'upcoming', 'completed', 'cancelled', 'rescheduled'],
    default: 'pending',
    index: true
  },
  rescheduleCount: { 
    type: Number,
    default: 0
  },

  // --- Financials & Gateway Transactions ---
  amount: {
    type: Number,
    required: true,
    default: 0
  },
  currency: {
    type: String,
    default: 'INR'
  },
  coupon: { 
    type: String, 
    default: null 
  },
  paymentId: {
    type: String 
  },
  razorpayPaymentId: { 
    type: String
  },
  razorpayOrderId: { 
    type: String
  },
  refundAmount: { 
    type: Number,
    default: 0
  },
  refundStatus: { 
    type: String,
    enum: ['none', 'pending', 'processed', 'failed'],
    default: 'none'
  },

  // --- Automation & System Logs ---
  remindersSent: {
    email24h: { type: Boolean, default: false },
    email1h:  { type: Boolean, default: false },
    sms1h:    { type: Boolean, default: false } 
  },
  notes: {
    type: String,
    maxlength: 500,
    default: ''
  },
  completedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelReason: { type: String }
}, {
  timestamps: true,
  collection: 'bookings' 
});

bookingSchema.index({ userId: 1, status: 1, scheduledAt: -1 });
bookingSchema.index({ mentorId: 1, status: 1, scheduledAt: -1 });
bookingSchema.index({ email: 1, scheduledAt: -1 });

const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;