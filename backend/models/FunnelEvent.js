import mongoose from 'mongoose';

// Product funnel analytics: one row per step a student reaches (chat → handoff →
// mentor click → clarity → profile → booking → purchase). Separate from
// EmailPipeline.trackEvent, which only drives lifecycle emails and drops guests.
const funnelEventSchema = new mongoose.Schema({
  event:    { type: String, required: true, index: true },
  // The chat session id — ties a guest's steps together across pages.
  funnelId: { type: String, default: null, index: true },
  // Anonymous per-browser id, set on first visit. Once the visitor signs in,
  // their earlier anonymous events get the userId too (routes/eventRoutes.js).
  visitorId: { type: String, default: null, index: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  props:    { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Keep 180 days of funnel history.
funnelEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const FunnelEvent = mongoose.model('FunnelEvent', funnelEventSchema);
export default FunnelEvent;
