import mongoose from 'mongoose';

// One row per WhatsApp number. `state` drives the chat state machine in
// services/whatsapp/WhatsAppAgent.js.
const waConversationSchema = new mongoose.Schema({
  waId:   { type: String, required: true, unique: true },   // E.164 digits, e.g. 919876543210
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  name:   { type: String, default: '' },                     // WhatsApp profile name
  state: {
    type: String,
    enum: ['email', 'otp', 'college', 'branch', 'year', 'goal', 'ready', 'pick_slot', 'payment_pending'],
    default: 'email',
  },
  pendingEmail: { type: String, default: null },
  otpHash:      { type: String, default: null },
  otpExpires:   { type: Date, default: null },
  otpAttempts:  { type: Number, default: 0 },
  profile: {
    college: { type: String, default: '' },
    branch:  { type: String, default: '' },
    year:    { type: String, default: '' },
    goal:    { type: String, default: '' },
  },
  lastQuestion: { type: String, default: '' },
  mentorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
  seenIds:      { type: [String], default: [] },             // last inbound message ids (dedupe retries)
  lastInboundAt:{ type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('WaConversation', waConversationSchema);
