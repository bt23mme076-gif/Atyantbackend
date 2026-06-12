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

  // ── LiveKit in-house meet ──
  livekitRoomName: { type: String },               // LiveKit room name e.g. session_<id>
  egressId:        { type: String },               // LiveKit egress job id for audio recording
  pipelineStatus:  { type: String, enum: ['none', 'processing', 'completed', 'failed'], default: 'none' },

  // ── Reminder emails (sent by ReminderCron) — flags prevent duplicate sends ──
  remindersSent:  {
    email24h: { type: Boolean, default: false },
    email1h:  { type: Boolean, default: false },
  },

  // ── Payment (Razorpay) — all money lands in the company Razorpay account ──
  amount:         { type: Number, default: 0 },          // INR (rupees) the student paid for the session
  currency:       { type: String, default: 'INR' },
  paymentStatus:  { type: String, enum: ['free', 'created', 'paid', 'failed'], default: 'free', index: true },
  razorpayOrderId:   { type: String, index: true },
  razorpayPaymentId: { type: String },
  couponCode:        { type: String },
  couponDiscount:    { type: Number, default: 0 },

  // ── Mentor payout ledger ──
  // Money is collected centrally, then mentors are paid their share in a monthly
  // batch. These fields make the month-end payout a single query.
  mentorShare:    { type: Number, default: 0 },          // INR owed to the mentor (net of platform fee)
  platformFeePct: { type: Number, default: 0 },          // % the platform kept on this session
  payoutStatus:   { type: String, enum: ['na', 'pending', 'paid'], default: 'na', index: true },
  payoutBatchId:  { type: String, index: true },         // groups sessions settled together
  paidOutAt:      { type: Date },                        // when the mentor was actually credited
}, { timestamps: true });

// Fast lookup for the month-end payout run.
sessionSchema.index({ payoutStatus: 1, mentorId: 1 });

sessionSchema.index({ userId: 1, status: 1, scheduledAt: -1 });

const Session = mongoose.model('Session', sessionSchema);
export default Session;
