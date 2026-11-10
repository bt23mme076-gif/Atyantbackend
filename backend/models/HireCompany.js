import mongoose from 'mongoose';

const { Schema } = mongoose;

// A startup hiring through Atyant Hire. One company per founder account in v1.
// Credits are counted in completed interviews: `free` on signup, `purchased`
// from Razorpay packs, `used` incremented when a candidate's report is billed.
const creditOrderSchema = new Schema({
  orderId  : { type: String, required: true },
  paymentId: { type: String, default: null },
  quantity : { type: Number, required: true },
  amount   : { type: Number, required: true },   // rupees
  status   : { type: String, enum: ['created', 'paid'], default: 'created' },
  createdAt: { type: Date, default: Date.now },
  paidAt   : { type: Date, default: null }
}, { _id: false });

const hireCompanySchema = new Schema({
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  name       : { type: String, required: true, trim: true, maxlength: 120 },
  website    : { type: String, default: '', trim: true, maxlength: 200 },
  logoUrl    : { type: String, default: '', trim: true, maxlength: 500 },
  about      : { type: String, default: '', trim: true, maxlength: 1000 },
  notifyPhone: { type: Boolean, default: true },

  credits: {
    free     : { type: Number, default: () => Number(process.env.HIRE_FREE_INTERVIEWS) || 10 },
    purchased: { type: Number, default: 0 },
    used     : { type: Number, default: 0 }
  },
  orders: [creditOrderSchema]
}, { timestamps: true });

hireCompanySchema.index({ 'orders.orderId': 1 });

export const creditsLeft = company =>
  (company?.credits?.free || 0) + (company?.credits?.purchased || 0) - (company?.credits?.used || 0);

export default mongoose.model('HireCompany', hireCompanySchema);
