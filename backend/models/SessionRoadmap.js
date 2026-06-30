import mongoose from 'mongoose';
import { roadmapStepSchema } from './Roadmap.js';

// A roadmap generated FROM a single mentor–student session's summary/analysis.
// One per session (unique sessionId). The student may have several of these —
// the frontend lists them and asks which session's roadmap to view when 2+ exist.
const sessionRoadmapSchema = new mongoose.Schema({
  sessionId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, unique: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  mentorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  topic:       { type: String },
  mentorName:  { type: String },
  summary:     { type: String },          // the session summary the roadmap was built from
  steps:       [roadmapStepSchema],
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const SessionRoadmap = mongoose.model('SessionRoadmap', sessionRoadmapSchema);
export default SessionRoadmap;
