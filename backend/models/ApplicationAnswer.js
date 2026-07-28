import mongoose from 'mongoose';

// Per-student answer bank for application-form questions that blocked auto-apply
// (screening questions, country of residence, sponsorship, etc). Keyed by a
// normalized version of the question label so the same saved answer applies
// across different companies asking the same/similar question, without the
// student ever re-typing it.
const applicationAnswerSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  questionKey: {
    type: String,
    required: true,
  },
  questionText: {
    type: String,
    required: true,
  },
  answerText: {
    type: String,
    required: true,
  },
}, { timestamps: true });

applicationAnswerSchema.index({ user: 1, questionKey: 1 }, { unique: true });

export function normalizeQuestionKey(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[*✱]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ApplicationAnswer = mongoose.model('ApplicationAnswer', applicationAnswerSchema);
export default ApplicationAnswer;

// { questionKey: answerText } — the shape the auto-apply adapters expect.
export async function getAnswerMap(userId) {
  const answers = await ApplicationAnswer.find({ user: userId }).lean();
  return Object.fromEntries(answers.map((a) => [a.questionKey, a.answerText]));
}
