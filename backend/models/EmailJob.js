import mongoose from 'mongoose';

// One scheduled lifecycle email (one step of one flow for one user).
// The pipeline cron picks up due `pending` jobs; several due jobs for the
// same user are merged into a single send and share the same `messageId`.
const emailJobSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  flow:     { type: String, required: true },          // signup | search | intent | purchase
  step:     { type: String, required: true },          // template key, e.g. 'signup_day1'
  priority: { type: Number, default: 0 },              // higher wins the "primary" slot when merged
  sendAt:   { type: Date, required: true },
  status:   { type: String, enum: ['pending', 'sent', 'cancelled', 'failed'], default: 'pending' },
  data:     { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupeKey:{ type: String, required: true, unique: true },
  messageId:{ type: String, default: null },           // Resend id of the email this job went out in
  sentAt:   { type: Date, default: null },
  reason:   { type: String, default: null },           // why cancelled / failed
  attempts: { type: Number, default: 0 },
}, { timestamps: true });

emailJobSchema.index({ status: 1, sendAt: 1 });
emailJobSchema.index({ userId: 1, flow: 1, status: 1 });
emailJobSchema.index({ userId: 1, sentAt: -1 });

export default mongoose.model('EmailJob', emailJobSchema);
