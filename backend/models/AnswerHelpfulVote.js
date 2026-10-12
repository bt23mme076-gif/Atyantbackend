import mongoose from 'mongoose';

// One "Helpful" vote per voter per answer card. Counts are derived by counting
// these docs, so a card's number can never drift from the real votes behind it.
// voterKey = "u:<userId>" for signed-in students, "v:<visitorId>" for guests.
const answerHelpfulVoteSchema = new mongoose.Schema({
  cardId  : { type: mongoose.Schema.Types.ObjectId, ref: 'AnswerCard', required: true, index: true },
  voterKey: { type: String, required: true, maxlength: 80 },
}, { timestamps: true });

answerHelpfulVoteSchema.index({ cardId: 1, voterKey: 1 }, { unique: true });

const AnswerHelpfulVote = mongoose.model('AnswerHelpfulVote', answerHelpfulVoteSchema);
export default AnswerHelpfulVote;
