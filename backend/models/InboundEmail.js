import mongoose from 'mongoose';

// Mail received on a student's apply-inbox alias (see services/autoapply/inbox.js).
// Security-code emails are consumed by the auto-apply robot; everything else is
// forwarded to the student's real address.
const inboundEmailSchema = new mongoose.Schema({
  resendId: { type: String, required: true, unique: true },
  alias: { type: String, required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  from: { type: String, default: '' },
  subject: { type: String, default: '' },
  code: { type: String, default: '' },
  forwarded: { type: Boolean, default: false },
  receivedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Keep inbox metadata for 30 days only.
inboundEmailSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('InboundEmail', inboundEmailSchema);
