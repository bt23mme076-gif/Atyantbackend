import mongoose from 'mongoose';

const savedAnswerSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  question:     { type: String, required: true },
  tags:         [{ type: String }],
  sourceType:   { type: String, enum: ['ai', 'mentor', 'clarity'], default: 'mentor' },
  answerCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerCard' },
  mentorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Set for pipeline auto-saved session summaries/action items — lets a
  // /reprocess run replace its own previous cards instead of duplicating them.
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true },
  savedAt:      { type: Date, default: Date.now },
}, { timestamps: true });

savedAnswerSchema.index({ userId: 1, savedAt: -1 });

const SavedAnswer = mongoose.model('SavedAnswer', savedAnswerSchema);
export default SavedAnswer;
