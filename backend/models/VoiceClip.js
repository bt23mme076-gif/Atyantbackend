import mongoose from 'mongoose';

const { Schema } = mongoose;

// A library line (services/voice/voiceLines.js LIBRARY) recorded in one voice,
// reused by every interview in that voice. A changed line text is a new clip.
const voiceClipSchema = new Schema({
  voiceId   : { type: String, required: true },   // "<model>|<voice>"
  key       : { type: String, required: true },
  text      : { type: String, required: true },
  url       : { type: String, required: true },
  sampleRate: { type: Number, required: true },
  durationMs: { type: Number, default: null }
}, { timestamps: true });

voiceClipSchema.index({ voiceId: 1, key: 1, text: 1 }, { unique: true });

export default mongoose.models.VoiceClip || mongoose.model('VoiceClip', voiceClipSchema);
