import mongoose from 'mongoose';
// models/Session.js
const sessionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // optional if guest
  mentorId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  mentorName:     { type: String, default: 'Your Mentor' },
  mentorInitials: { type: String, default: 'YM' },

  // Booking-page fields
  name:           { type: String, required: true },
  email:          { type: String, required: true, trim: true, lowercase: true },
  phone:          { type: String, default: '' },
  sessionType:    { type: String, required: true },   // "Audio Call" | "Video Call" | "Career Roadmap"
  amount:         { type: Number, required: true },
  goals:          { type: [String], default: [] },
  brief:          { type: String, maxlength: 600, default: '' },
  coupon:         { type: String, default: null },

  topic:          { type: String, default: 'Career Guidance Session' },
  scheduledAt:    { type: Date, required: true, index: true },
  status:         { type: String, enum: ['upcoming', 'completed', 'cancelled', 'pending'], default: 'pending', index: true },
  meetingLink:    { type: String },
  notes:          { type: String, maxlength: 500 },
}, { timestamps: true });

sessionSchema.index({ userId: 1, status: 1, scheduledAt: -1 });
sessionSchema.index({ email: 1, scheduledAt: -1 });  // for guest lookups

const Session = mongoose.model('Session', sessionSchema);
export default Session;