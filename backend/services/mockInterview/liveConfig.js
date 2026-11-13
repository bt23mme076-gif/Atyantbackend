// Shared by the API (room + dispatch) and the interview agent worker.
export const MOCK_AGENT_NAME = process.env.MOCK_AGENT_NAME || 'mock-interviewer';
export const INTERVIEW_DURATION_MS = 15 * 60 * 1000; // every interview is ₹10 / 15 minutes

// Hiring interviews run for the founder-chosen length (5-15 min).
export const interviewDurationMs = interview =>
  interview.mode === 'hiring' && interview.hire?.durationMin ? interview.hire.durationMin * 60 * 1000 : INTERVIEW_DURATION_MS;
export const mockRoomName = interviewId => `mock_${interviewId}`;
// Hiring candidates have no account: their LiveKit identity is tied to the application.
export const hireParticipantIdentity = applicationId => `cand_${applicationId}`;
