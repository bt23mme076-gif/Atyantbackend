import { frontendBase } from '../../utils/frontendUrl.js';
import { B, ACCENT, esc, p, list, renderLayout } from './layout.js';

// ─────────────────────────────────────────────────────────────
//  Lifecycle email templates
//
//  Each template returns:
//    subject, heading, body (html), cta {label, url}
//    teaser {title, text, cta}  — used when this job is folded into
//                                 another email as an "Also for you" block
// ─────────────────────────────────────────────────────────────

const clip = (s = '', n = 80) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// The product app is served at the root of atyant.in, so every CTA lands there with UTM tags for attribution.
export function appLink(campaign, content) {
  const qs = new URLSearchParams({ utm_source: 'email', utm_medium: 'lifecycle', utm_campaign: campaign, utm_content: content });
  return `${frontendBase()}/?${qs}`;
}


const PAGE_LABEL = {
  pricing: 'our plans',
  mentor_profile: 'that mentor',
  mock_interview: 'AI mock interviews',
  auto_apply: 'Auto-Apply',
};

function mentorList(mentors = []) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0 18px;">${
    mentors.slice(0, 3).map(m => `
      <tr><td style="padding:14px 16px;background:${B.card};border:1px solid ${B.border};border-radius:12px;">
        <div style="font-weight:600;color:${B.text};">${esc(m.name)}</div>
        <div style="color:${B.primaryText};font-size:13px;margin-top:2px;">${esc(m.outcome || '')}</div>
        ${m.matchReason ? `<div style="color:${B.textSub};font-size:13px;margin-top:4px;">${esc(clip(m.matchReason, 120))}</div>` : ''}
      </td></tr><tr><td style="height:8px;"></td></tr>`).join('')
  }</table>`;
}

function jobList(jobs = []) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0 18px;">${
    jobs.slice(0, 3).map(j => `
      <tr><td style="padding:14px 16px;background:${B.card};border:1px solid ${B.border};border-radius:12px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;"><tr>
          <td style="vertical-align:top;">
            <div style="font-weight:600;color:${B.text};font-size:15px;">${esc(clip(j.title, 70))}</div>
            <div style="color:${B.textSub};font-size:13px;margin-top:3px;">${esc(j.company)}${j.location ? ` · ${esc(clip(j.location, 40))}` : ''}</div>
            ${j.matchedSkills?.length ? `<div style="color:${B.textMuted};font-size:12px;margin-top:6px;">Matches your ${esc(j.matchedSkills.slice(0, 4).join(', '))}</div>` : ''}
          </td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:12px;">
            <span style="display:inline-block;background:${ACCENT.default.bg};color:${B.primaryText};font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;">${Number(j.score) || 0}% match</span>
          </td>
        </tr></table>
      </td></tr><tr><td style="height:8px;"></td></tr>`).join('')
  }</table>`;
}

export const TEMPLATES = {
  // ── Job portal ─────────────────────────────────────────────
  jobs_welcome: ({ name, data }) => {
    const jobs = data.jobs || [];
    const total = data.total || jobs.length;
    return {
      accent: 'jobs',
      tag: 'Job matches',
      subject: total > 1
        ? `${name}, ${total} open roles match your profile`
        : `${name}, a role at ${jobs[0]?.company || 'a top company'} matches your profile`,
      heading: `Roles that fit you, ${esc(name)}.`,
      body:
        p('Welcome to the <strong>Atyant Job Portal</strong>, where we pull live openings from companies like Stripe, Postman, PhonePe, Groww and 50+ more, and rank them against your skills and projects.') +
        (jobs.length ? p(jobs.length > 1 ? `Here are your top ${jobs.length} matches right now:` : 'Here is your top match right now:') + jobList(jobs) : '') +
        p('New roles are added every 6 hours. Turn on <strong>Auto-Apply</strong> and we fill and submit the forms for you, with a cover letter written for each job.'),
      cta: { label: 'See all my matches →', url: appLink('jobs', 'welcome') },
      signoff: 'If you have questions or want help with your applications, just reply to this email. We read everything.',
      teaser: { title: 'Jobs that match your profile', text: `${total} open roles ranked for you.`, cta: 'See matches' },
    };
  },

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
      list([
        'Complete your profile so matches and Auto-Apply get sharper.',
        'Ask your hardest career question and talk to a matched senior.',
        'Run one AI mock interview to find your weak spots early.',
      ], true),
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
  return renderLayout({ ...primary, extras: teasers.filter(Boolean), unsubscribeUrl });
}
