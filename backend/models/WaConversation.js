import mongoose from 'mongoose';

// One row per WhatsApp number. `state` drives the chat state machine in
// services/whatsapp/WhatsAppAgent.js. Legacy onboarding states (email, college,
// branch, year, goal, ready) are kept in the enum so older rows still load;
// the agent treats them as 'chat'.
const waConversationSchema = new mongoose.Schema({
  waId:   { type: String, required: true, unique: true },   // E.164 digits, e.g. 919876543210
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  name:   { type: String, default: '' },                     // WhatsApp profile name
  state: {
    type: String,
    enum: ['chat', 'pick_slot', 'booking_email', 'otp', 'confirm', 'payment_pending',
      'email', 'college', 'branch', 'year', 'goal', 'ready'],
    default: 'chat',
  },
  pendingEmail: { type: String, default: null },
  otpHash:      { type: String, default: null },
  otpExpires:   { type: Date, default: null },
  otpAttempts:  { type: Number, default: 0 },
  // Latest facts from the chat — a correction overwrites the old value.
  profile: {
    college:   { type: String, default: '' },
    branch:    { type: String, default: '' },
    year:      { type: String, default: '' },
    goal:      { type: String, default: '' },
    companies: { type: [String], default: [] },
  },
  lastQuestion: { type: String, default: '' },
  lastAnswer:   { type: String, default: '' },
  matchIds:     { type: [String], default: [] },               // seniors matched to the last answer
  mentorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pendingSlot:  { type: Number, default: null },               // chosen slot (ms) awaiting email/consent
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
  seenIds:      { type: [String], default: [] },               // last inbound message ids (dedupe retries)
  lastInboundAt:{ type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('WaConversation', waConversationSchema);
