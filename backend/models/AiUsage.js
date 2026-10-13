import mongoose from 'mongoose';

// Daily AI-chat usage counter. key = 'u:<userId>' | 'ip:<ip>' | 'global'; day = IST date (YYYY-MM-DD).
const aiUsageSchema = new mongoose.Schema({
  key:       { type: String, required: true },
  day:       { type: String, required: true },
  kind:      { type: String, enum: ['msg', 'resume'], default: 'msg' },
  count:     { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

aiUsageSchema.index({ key: 1, day: 1, kind: 1 }, { unique: true });
aiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AiUsage', aiUsageSchema);
