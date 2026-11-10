// Founder notifications for Atyant Hire. Never throws: a failed notification
// must not affect evaluation.
import { Resend } from 'resend';
import HireJob from '../../models/HireJob.js';
import HireCompany from '../../models/HireCompany.js';
import User from '../../models/User.js';
import { notifyStudent } from '../whatsapp/notify.js';
import { esc, p, small, details, renderLayout } from '../email/layout.js';

const APP_URL = (process.env.PUBLIC_APP_URL || 'https://www.atyant.in').replace(/\/+$/, '');
export const dashboardLink = (jobId, applicationId) =>
  `${APP_URL}/hire/jobs/${jobId}${applicationId ? `?candidate=${applicationId}` : ''}`;
export const publicJobLink = slug => `${APP_URL}/hire/i/${slug}`;

const VERDICT_LABEL = { strong_yes: 'Strong yes', yes: 'Yes', maybe: 'Maybe', no: 'No' };

let resend = null;
const getResend = () => {
  if (!resend && process.env.RESEND_API_KEY) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
};

export async function notifyFounderReportReady(app) {
  try {
    const job = await HireJob.findById(app.jobId).select('title ownerUserId').lean();
    const company = await HireCompany.findById(app.companyId).select('notifyPhone').lean();
    const owner = await User.findById(job?.ownerUserId).select('email').lean();
    if (!job) return;

    const link = dashboardLink(job._id, app._id);
    const score = app.result?.overall != null ? `${Math.round(app.result.overall)}/100` : '—';
    const verdict = VERDICT_LABEL[app.result?.verdict] || '—';
    const name = app.candidate.name;

    if (owner?.email && getResend()) {
      await getResend().emails.send({
        from: 'Atyant Hire <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [owner.email],
        subject: `${name} finished the ${job.title} interview: ${verdict} (${score})`,
        text: `${name} completed the AI screening interview for ${job.title}.\nScore: ${score}\nVerdict: ${verdict}\n\n${app.result?.summary || ''}\n\nFull report: ${link}`,
        html: renderLayout({
          tag: 'Atyant Hire',
          heading: `${esc(name)} finished the interview.`,
          body: p(`Screening result for <strong>${esc(job.title)}</strong>:`) +
            details([['Score', score], ['Verdict', verdict], ['Questions reached', `${app.result?.coveragePct ?? 0}%`]]) +
            (app.result?.summary ? p(esc(app.result.summary)) : '') +
            small('Scores are based only on what the candidate said. Every strength and concern in the report is backed by a quote from the transcript.'),
          cta: { label: 'Open full report', url: link },
        }),
      }).catch(err => console.error('Hire report email failed:', err.message));
    }

    if (company?.notifyPhone !== false && job.ownerUserId) {
      await notifyStudent(job.ownerUserId, {
        text: `🧑‍💼 *${name}* finished the *${job.title}* interview.\nScore: *${score}* · Verdict: *${verdict}*\n\nReport: ${link}`,
        template: process.env.WA_TPL_HIRE_REPORT,
        params: [name, job.title, score, verdict, link],
      });
    }
  } catch (err) {
    console.error('Hire founder notify failed:', err.message);
  }
}
