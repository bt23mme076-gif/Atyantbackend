import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const identitySchema = new mongoose.Schema({
  college: { type: String, default: null },
  collegeType: { type: String, default: null }, // Tier-1, Tier-2, Tier-3, IIT, NIT, etc.
  branch: { type: String, default: null },
  year: { type: String, default: null },
  cgpa: { type: String, default: null }
}, { _id: false });

const contextSchema = new mongoose.Schema({
  identity: { type: identitySchema, default: () => ({}) },
  target: { type: String, default: null },
  gap: { type: [String], default: [] },
  timeline: { type: String, default: null },
  constraint: { type: [String], default: [] }
}, { _id: false });

const atyantConversationSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  messages: { type: [messageSchema], default: [] },
  context: { type: contextSchema, default: () => ({}) },
  contextLayers: { type: Number, default: 0, min: 0, max: 5 },
  phase: {
    type: String,
    enum: ['collecting', 'engine'],
    default: 'collecting'
  },
  problemStatement: { type: String, default: null },
  outputMode: {
    type: String,
    enum: ['AI_ANSWER', 'MENTOR_ROUTING', 'CLARIFY', null],
    default: null
  }
}, { timestamps: true });

// Auto-expire sessions after 7 days of inactivity
atyantConversationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const AtyantConversation = mongoose.model('AtyantConversation', atyantConversationSchema);
export default AtyantConversation;
