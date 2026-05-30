import mongoose from 'mongoose';

const roadmapStepSchema = new mongoose.Schema({
  phase:    { type: String },
  title:    { type: String },
  duration: { type: String },
  status:   { type: String, enum: ['active', 'upcoming', 'locked', 'completed'], default: 'upcoming' },
  tasks:    [{ type: String }],
}, { _id: false });

const roadmapSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  goal:        { type: String },
  college:     { type: String },
  branch:      { type: String },
  steps:       [roadmapStepSchema],
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const Roadmap = mongoose.model('Roadmap', roadmapSchema);
export default Roadmap;
