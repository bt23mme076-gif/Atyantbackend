import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  mentorId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  mentorName:     { type: String, default: 'Your Mentor' },
  mentorInitials: { type: String, default: 'YM' },
  topic:          { type: String, default: 'Career Guidance Session' },
  serviceId:      { type: String },   // platform service id (config/serviceCatalog.js)
  scheduledAt:    { type: Date, required: true, index: true },
  durationMin:    { type: Number, default: 30 },
  status:         { type: String, enum: ['pending', 'upcoming', 'completed', 'cancelled'], default: 'upcoming', index: true },
  meetingLink:    { type: String },
  calendarEventId:{ type: String },
  notes:          { type: String, maxlength: 500 },

  // ── Payment (Razorpay) ──
  amount:         { type: Number, default: 0 },          // INR (rupees)
  currency:       { type: String, default: 'INR' },
  paymentStatus:  { type: String, enum: ['free', 'created', 'paid', 'failed'], default: 'free', index: true },
  razorpayOrderId:   { type: String, index: true },
  razorpayPaymentId: { type: String },
}, { timestamps: true });

sessionSchema.index({ userId: 1, status: 1, scheduledAt: -1 });

const Session = mongoose.model('Session', sessionSchema);
export default Session;
