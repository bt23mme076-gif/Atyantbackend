// Shared by the API (room + dispatch) and the interview agent worker.
export const MOCK_AGENT_NAME = process.env.MOCK_AGENT_NAME || 'mock-interviewer';
export const INTERVIEW_DURATION_MS = 30 * 60 * 1000;
export const mockRoomName = interviewId => `mock_${interviewId}`;
