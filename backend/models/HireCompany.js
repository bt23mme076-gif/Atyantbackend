import mongoose from 'mongoose';

const { Schema } = mongoose;

// A startup hiring through Atyant Hire. One company per founder account in v1.
// Interviews are free: no credits, no billing.
const hireCompanySchema = new Schema({
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  name       : { type: String, required: true, trim: true, maxlength: 120 },
  website    : { type: String, default: '', trim: true, maxlength: 200 },
  logoUrl    : { type: String, default: '', trim: true, maxlength: 500 },
  about      : { type: String, default: '', trim: true, maxlength: 1000 },
  notifyPhone: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model('HireCompany', hireCompanySchema);
