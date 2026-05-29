import mongoose from 'mongoose';

const PushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: String,
    auth: String,
  },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional: link to user
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('PushSubscription', PushSubscriptionSchema);
