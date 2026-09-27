import { frontendBase } from '../../utils/frontendUrl.js';

// ─────────────────────────────────────────────────────────────
//  Lifecycle email templates
//
//  Each template returns:
//    subject, heading, body (html), cta {label, url}
//    teaser {title, text, cta}  — used when this job is folded into
//                                 another email as an "Also for you" block
// ─────────────────────────────────────────────────────────────

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const clip = (s = '', n = 80) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// The product app is only reachable at the root (+ /atyantEngine on atyant.in),
// so every CTA lands there with UTM tags for attribution.
export function appLink(campaign, content) {
  const suffix = (process.env.FRONTEND_URL || '').includes('atyant.in') ? '/atyantEngine' : '';
  const qs = new URLSearchParams({ utm_source: 'email', utm_medium: 'lifecycle', utm_campaign: campaign, utm_content: content });
  return `${frontendBase()}${suffix}/?${qs}`;
}

const p = (html) => `<p style="color:#4b5563;line-height:1.6;margin:0 0 14px;">${html}</p>`;

const PAGE_LABEL = {
  pricing: 'our plans',
  mentor_profile: 'that mentor',
  mock_interview: 'AI mock interviews',
  auto_apply: 'Auto-Apply',
};

function mentorList(mentors = []) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0 18px;">${
    mentors.slice(0, 3).map(m => `
      <tr><td style="padding:12px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="font-weight:600;color:#111827;">${esc(m.name)}</div>
        <div style="color:#4F46E5;font-size:13px;margin-top:2px;">${esc(m.outcome || '')}</div>
        ${m.matchReason ? `<div style="color:#6b7280;font-size:13px;margin-top:4px;">${esc(clip(m.matchReason, 120))}</div>` : ''}
      </td></tr><tr><td style="height:8px;"></td></tr>`).join('')
  }</table>`;
}

export const TEMPLATES = {
  // ── Signup onboarding ──────────────────────────────────────
  signup_day1: ({ name }) => ({
    subject: `${name}, what's the one career question on your mind?`,
    heading: 'Ask your first question',
    body:
      p(`Most students on Atyant start with one question — <em>“How do I get an internship with my CGPA?”</em>, <em>“Should I do DSA or dev first?”</em>, <em>“How did seniors crack Amazon?”</em>`) +
      p('Type yours and we match you with seniors from your college and branch who already solved it. Takes 10 seconds.'),
    cta: { label: 'Ask my question', url: appLink('signup', 'day1') },
    teaser: { title: 'Got a career question?', text: 'Ask it and get matched with seniors who solved it.', cta: 'Ask now' },
  }),

  signup_day3: ({ name }) => ({
    subject: 'The senior who walked your exact path is already here',
    heading: `Someone like you already cracked it, ${name}`,
    body:
      p('Generic advice on YouTube doesn\'t know your college, your branch, or your CGPA. Seniors on Atyant do — they were in your seat a year or two ago.') +
      p('Every mentor is LinkedIn-verified. You can read how they did it, or book a 1:1 chat or video call.'),
    cta: { label: 'Meet my seniors', url: appLink('signup', 'day3') },
    teaser: { title: 'Seniors from your college', text: 'LinkedIn-verified mentors who walked your path.', cta: 'Meet them' },
  }),

  signup_day7: ({ name }) => ({
    subject: 'Practise your next interview before it counts',
    heading: `Try an AI mock interview, ${name}`,
    body:
      p('A realistic interviewer that asks follow-ups and cross-questions — like a real panel, not a quiz.') +
      p('You get a detailed evaluation after: what went well, where you lost the interviewer, and what to fix.'),
    cta: { label: 'Start a mock interview', url: appLink('signup', 'day7') },
    teaser: { title: 'AI mock interview', text: 'Real follow-ups, detailed feedback.', cta: 'Try it' },
  }),

  // ── Search intent ──────────────────────────────────────────
  search_mentors: ({ name, data }) => {
    const q = clip(data.query || 'your question', 70);
    const mentors = data.mentors || [];
    return {
      subject: mentors.length
        ? `${mentors.length > 1 ? `${Math.min(mentors.length, 3)} seniors have` : 'A senior has'} already solved “${clip(q, 40)}”`
        : `About your question: “${clip(q, 45)}”`,
      heading: `${name}, these seniors have been exactly where you are`,
      body:
        p(`You asked: <strong>“${esc(q)}”</strong>. Reading answers helps — but a 20-minute conversation with someone who did it is faster.`) +
        (mentors.length ? mentorList(mentors) : '') +
        p('Pick one and ask them directly.'),
      cta: { label: 'Talk to a senior', url: appLink('search', 'mentors') },
      teaser: { title: `Seniors who solved “${esc(clip(q, 40))}”`, text: 'Talk to someone who did it.', cta: 'See mentors' },
    };
  },

  search_mock: ({ name, data }) => {
    const q = clip(data.query || 'your goal', 60);
    return {
      subject: 'Don\'t just read about it — rehearse it',
      heading: `Ready to practise, ${name}?`,
      body:
        p(`You were looking into <strong>“${esc(q)}”</strong>. The fastest way to find your gaps is to face the interview before the real one.`) +
        p('Our AI interviewer digs into your answers and cross-questions like a real panel, then tells you exactly what to fix.'),
      cta: { label: 'Start a mock interview', url: appLink('search', 'mock') },
      teaser: { title: 'Rehearse the interview', text: 'AI interviewer + detailed feedback.', cta: 'Practise' },
    };
  },

  // ── Browse / pricing abandonment ───────────────────────────
  intent_reminder: ({ name, data }) => {
    const what = PAGE_LABEL[data.page] || 'Atyant';
    return {
      subject: `Still thinking about ${what}?`,
      heading: `You were checking out ${what}, ${name}`,
      body:
        p('No pressure — we saved your spot. Pick up exactly where you left off.') +
        (data.label ? p(`Last viewed: <strong>${esc(clip(data.label, 80))}</strong>`) : ''),
      cta: { label: 'Continue', url: appLink('intent', 'reminder') },
      teaser: { title: `Still thinking about ${what}?`, text: 'Pick up where you left off.', cta: 'Continue' },
    };
  },

  intent_objection: ({ name }) => ({
    subject: 'Is it worth it? Straight answers',
    heading: `The honest answers, ${name}`,
    body:
      p('<strong>Who are the mentors?</strong><br>Seniors and professionals, each LinkedIn-verified, matched to your college, branch and goal.') +
      p('<strong>What do I actually get?</strong><br>A 1:1 chat or video call with someone who already did what you\'re trying to do — not generic advice.') +
      p('<strong>Not sure which option fits?</strong><br>Reply to this email with your situation. A real person reads it and will point you to the right one.'),
    cta: { label: 'Take another look', url: appLink('intent', 'objection') },
    teaser: { title: 'Is it worth it?', text: 'Straight answers to the common questions.', cta: 'Read' },
  }),

  intent_help: ({ name }) => ({
    subject: 'Can I help you choose?',
    heading: `Quick one, ${name}`,
    body:
      p('I noticed you were looking around Atyant but didn\'t go ahead. Totally fine.') +
      p('If something stopped you — price, timing, not sure it\'ll help — just hit reply and tell me. I read every reply and I\'ll help you figure out if it\'s right for you.') +
      p('— Team Atyant'),
    cta: { label: 'Back to Atyant', url: appLink('intent', 'help') },
    teaser: null, // personal note — never folded into another email
  }),

  // ── Post-purchase ──────────────────────────────────────────
  purchase_feedback: ({ name, data }) => (data.kind === 'subscription' ? {
    subject: `Getting the most out of your ${data.plan || ''} plan`.replace(/\s+/g, ' '),
    heading: `You're all set, ${name}`,
    body:
      p('Three things members do in week one:') +
      `<ol style="color:#4b5563;line-height:1.8;margin:0 0 16px 18px;padding:0;">
        <li>Complete your profile so matches and Auto-Apply get sharper.</li>
        <li>Ask your hardest career question and talk to a matched senior.</li>
        <li>Run one AI mock interview to find your weak spots early.</li>
      </ol>`,
    cta: { label: 'Open Atyant', url: appLink('purchase', 'sub_onboard') },
    teaser: { title: 'Get the most from your plan', text: '3 things to do in week one.', cta: 'Open' },
  } : {
    subject: `How was your session with ${data.mentorName || 'your mentor'}?`,
    heading: `How did it go, ${name}?`,
    body:
      p(`Your feedback helps ${esc(data.mentorName || 'your mentor')} and helps the next student pick the right senior. It takes 30 seconds.`) +
      p('If something didn\'t go well, reply to this email — we\'ll make it right.'),
    cta: { label: 'Share feedback', url: appLink('purchase', 'feedback') },
    teaser: { title: 'Rate your session', text: '30 seconds, helps the next student.', cta: 'Rate' },
  }),

  purchase_crosssell: ({ name, data }) => (data.kind === 'subscription' ? {
    subject: 'Talk to someone who\'s done it',
    heading: `Next step, ${name}: a 1:1 with a senior`,
    body:
      p('Applying is half the game. A 20-minute call with a senior who cracked the same companies tells you what the job post won\'t.'),
    cta: { label: 'Find my senior', url: appLink('purchase', 'sub_crosssell') },
    teaser: { title: 'Book a 1:1 with a senior', text: 'Learn what the job post won\'t tell you.', cta: 'Find one' },
  } : {
    subject: 'Turn that advice into practice',
    heading: `Put it to the test, ${name}`,
    body:
      p('You\'ve got the roadmap from your mentor. Now rehearse it — our AI interviewer asks follow-ups and cross-questions like a real panel, then shows you exactly what to fix.'),
    cta: { label: 'Start a mock interview', url: appLink('purchase', 'crosssell') },
    teaser: { title: 'Rehearse with an AI interviewer', text: 'Turn advice into practice.', cta: 'Practise' },
  }),
};

// Wrap a primary template (+ optional merged teasers) in the brand layout.
export function renderEmail(primary, teasers, unsubscribeUrl) {
  const extras = teasers.filter(Boolean);
  const alsoBlock = extras.length ? `
    <div style="margin-top:26px;">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px;">Also for you</div>
      ${extras.map(t => `
        <div style="padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;background:#ffffff;">
          <div style="font-weight:600;color:#111827;">${t.title}</div>
          <div style="color:#6b7280;font-size:13px;margin:2px 0 6px;">${t.text}</div>
          <a href="${t.url}" style="color:#4F46E5;font-size:13px;font-weight:600;text-decoration:none;">${t.cta} →</a>
        </div>`).join('')}
    </div>` : '';

  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="text-align:center;margin-bottom:24px;"><h1 style="color:#4F46E5;margin:0;">Atyant</h1></div>
    <div style="background-color:#f8fafc;padding:30px;border-radius:10px;border-left:4px solid #4F46E5;">
      <h2 style="color:#1f2937;margin-top:0;">${primary.heading}</h2>
      ${primary.body}
      <div style="text-align:center;margin:26px 0 6px;">
        <a href="${primary.cta.url}" style="background-color:#4F46E5;color:white;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">${primary.cta.label}</a>
      </div>
      ${alsoBlock}
    </div>
    <div style="text-align:center;margin-top:30px;color:#9ca3af;font-size:12px;">
      <p>Questions? Just reply — a real person reads it.</p>
      <p><a href="${unsubscribeUrl}" style="color:#9ca3af;">Unsubscribe from these emails</a></p>
      <p>&copy; ${new Date().getFullYear()} Atyant. All rights reserved.</p>
    </div>
  </div>`;
}
