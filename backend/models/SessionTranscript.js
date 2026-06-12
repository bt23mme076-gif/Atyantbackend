import mongoose from 'mongoose';

const sessionTranscriptSchema = new mongoose.Schema({
  sessionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, unique: true, index: true },
  rawText:    { type: String, required: true },
  segments:   [{
    text:     { type: String },
    start:    { type: Number }, // seconds
    end:      { type: Number },
  }],
  language:   { type: String, default: 'en' },
  duration:   { type: Number }, // seconds
}, { timestamps: true });

const SessionTranscript = mongoose.model('SessionTranscript', sessionTranscriptSchema);
export default SessionTranscript;
