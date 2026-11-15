import mongoose from 'mongoose';

const { Schema } = mongoose;

// A startup's intern requirement from the public Atyant Hire form (brochure QR
// / link). Five fields only: stipend, seats, duration etc. are settled on the
// follow-up call, then the agreement is signed.
const hireLeadSchema = new Schema({
  company    : { type: String, required: true, trim: true, maxlength: 120 },
  contactName: { type: String, required: true, trim: true, maxlength: 120 },
  phone      : { type: String, required: true, trim: true, maxlength: 15 },
  email      : { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
  role       : { type: String, required: true, trim: true, maxlength: 120 },
  source     : { type: String, default: 'link', trim: true, maxlength: 40 },
  status     : { type: String, default: 'new', enum: ['new', 'contacted', 'agreement_signed', 'closed'], index: true },
}, { timestamps: true });

hireLeadSchema.index({ phone: 1, createdAt: -1 });

export default mongoose.model('HireLead', hireLeadSchema);
