import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  mentorId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  mentorName:     { type: String, default: 'Your Mentor' },
  mentorInitials: { type: String, default: 'YM' },
  topic:          { type: String, default: 'Career Guidance Session' },
  scheduledAt:    { type: Date, required: true, index: true },
  status:         { type: String, enum: ['upcoming', 'completed', 'cancelled'], default: 'upcoming', index: true },
  meetingLink:    { type: String },
  notes:          { type: String, maxlength: 500 },
}, { timestamps: true });

sessionSchema.index({ userId: 1, status: 1, scheduledAt: -1 });

const Session = mongoose.model('Session', sessionSchema);
export default Session;
