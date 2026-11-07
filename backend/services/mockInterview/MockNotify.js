// WhatsApp messages about a student's mock interview. Never throws: a failed
// notification must not affect evaluation or payments.
import { notifyStudent } from '../whatsapp/notify.js';

// Not frontendBase(): production runs with NODE_ENV=development, which would
// pick LOCAL_FRONTEND_URL. These links leave the server, so they're fixed.
const APP_URL = (process.env.PUBLIC_APP_URL || 'https://www.atyant.in').replace(/\/+$/, '');
export const interviewLink = (id) => `${APP_URL}/mock-interview?interview=${id}`;

const label = (iv) => [iv.role, iv.company].filter(Boolean).join(' at ') || 'your mock interview';

export async function notifyReportReady(interview, overall) {
  try {
    const link = interviewLink(interview._id);
    const score = Number.isFinite(overall) ? `${Math.round(overall)}/100` : 'ready';
    await notifyStudent(interview.userId, {
      text: `📊 Your report for *${label(interview)}* is ready: *${score}*.\n\nSee what to fix before the real interview:\n${link}`,
      template: process.env.WA_TPL_MOCK_REPORT,
      params: [label(interview), score, link],
    });
  } catch (err) {
    console.error('WA report notify failed:', err.message);
  }
}

export async function notifyCheckoutPending(interview) {
  try {
    const link = interviewLink(interview._id);
    const amount = `₹${interview.entryPayment?.amount ?? ''}`;
    await notifyStudent(interview.userId, {
      text: `⏳ Your ${amount} mock interview for *${label(interview)}* is still waiting. Your questions are ready, pick up where you left off:\n${link}`,
      template: process.env.WA_TPL_MOCK_CHECKOUT,
      params: [amount, label(interview), link],
    });
  } catch (err) {
    console.error('WA checkout nudge failed:', err.message);
  }
}
