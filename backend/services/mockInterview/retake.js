// Shared by the planner (what a retake re-tests) and the report (progress).
import { CORE_TOPICS, getRoleFamilySheet } from '../../config/mockInterviewTopics.js';

// Human name for a question's area, for the progress section of the report.
export function areaLabel(question, interview) {
  if (question.ref?.type === 'claim') {
    return interview.parsed?.resume?.claims?.find(c => c.id === question.ref.id)?.claim || question.text;
  }
  const core = CORE_TOPICS.find(t => t.id === question.topic);
  if (core) return core.name;
  const sheetTopic = getRoleFamilySheet(interview.roleFamily)?.topics.find(t => t.id === question.topic);
  if (sheetTopic) return sheetTopic.name;
  const skills = [...(interview.parsed?.jd?.requiredSkills || []), ...(interview.parsed?.jd?.niceToHave || [])];
  return skills.find(s => s.id === question.topic || s.id === question.ref?.id)?.name || question.text;
}

export const WEAK_SCORE = 3;
const UNSCORED_TOPICS = new Set(['core.intro', 'core.questions_for_us']);

// What makes two questions "the same area" across attempts: the same resume
// claim, or the same topic.
export const retestKey = q => (q.ref?.type === 'claim' ? `claim:${q.ref.id}` : `topic:${q.topic}`);

// Areas the student scored under WEAK_SCORE on, weakest first.
export function weakAreas(interview) {
  const questionByQid = new Map(interview.plan.questions.map(q => [q.qid, q]));
  const seen = new Set();
  return (interview.evaluation?.perAnswer || [])
    .filter(a => a.reached && a.score != null && a.score < WEAK_SCORE)
    .sort((a, b) => a.score - b.score)
    .map(a => questionByQid.get(a.qid))
    .filter(q => q && !UNSCORED_TOPICS.has(q.topic))
    .filter(q => {
      const key = retestKey(q);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
