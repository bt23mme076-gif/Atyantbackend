// Everything the interviewer can say from pre-made audio, shared by the backend
// (which records it before the interview) and the agent (which plays it).
//
// Two kinds of clips:
//   library    fixed lines, recorded once per voice and reused by every interview
//   interview  this interview's greeting, planned questions and planned follow-ups
// A "segment" is one piece of a spoken line: { key, text } plays a clip,
// { key: null, text } is spoken live (built from the candidate's own words).

export const LIBRARY = {
  // Neutral reactions only: an interviewer acknowledges, never grades.
  'react.okay'  : 'Okay.',
  'react.right' : 'Right.',
  'react.gotit' : 'Got it.',
  'react.mmhm'  : 'Mm-hm.',
  'react.isee'  : 'I see.',
  'react.thanks': 'Okay, thanks.',

  // The candidate trailed off mid-thought.
  'cont.goon'     : 'Go on.',
  'cont.time'     : 'Take your time.',
  'cont.goahead'  : 'Okay, go ahead.',
  'cont.listening': "Sure, I'm listening.",
  'cont.norush'   : 'Go ahead, no rush.',
  'cont.withyou'  : "I'm with you, go on.",

  // Misheard or too short to use.
  'repeat.1': "Sorry, I didn't catch that. Could you say that again?",
  'repeat.2': 'You cut out for a second there. One more time?',
  'repeat.3': 'Sorry, missed that. Say that again?',

  // They couldn't answer.
  'skip.noworries': 'No worries.',
  'skip.fair'     : 'Fair enough.',
  'skip.fine'     : "That's fine.",
  'skip.okay'     : "That's okay, happens.",
  'warm'          : 'No pressure, these are hard to answer on the spot.',

  'silence.take' : "Take your time. Let me know if you'd like me to repeat the question.",
  'moveon'       : "Let's move on for now.",
  'next.sure'    : "Sure, let's try something else.",
  'clarify.sure' : 'Sure.',

  'trans.resume'    : 'Let me pick something from your resume.',
  'trans.technical' : "Let's get a little technical now.",
  'trans.behavioral': 'Now a couple of situational ones.',
  'trans.closing'   : "We're coming to the end.",
  'time.warn'       : "We're almost at time, so one last thing.",

  // Closing. Mock interviews are practice, so a question the interviewer can't
  // answer is one to ask in the real interview. Hire candidates are in the real
  // one and get no report, so their questions go to the hiring team.
  'close.good'      : 'Those are good questions to ask in your real interview.',
  'close.end'       : "That's all from my side. Thanks for your time today, I enjoyed this. Your feedback report will be ready in a few minutes. All the best!",
  'timeup'          : "Alright, that's time, so we'll stop here. Thanks for taking this seriously. Your feedback report will be ready in a few minutes. All the best!",
  'close.defer.hire': "I don't have the details on that, but I'll pass it on to the team, and they'll get back to you.",
  'close.end.hire'  : "That's all from my side. Thanks for your time today. The hiring team will go through your interview and get back to you. All the best!",
  'timeup.hire'     : "Alright, that's time, so we'll stop here. Thanks for your time today. The hiring team will go through your interview and get back to you. All the best!",

  'back.resume': "Welcome back, sorry about the hiccup there. Let's pick up where we left off.",
  'back.drop'  : 'Welcome back, no worries, these drops happen.',

  'code.skip': "No worries, let's keep moving.",
  'code.pass': 'That passes all the tests.',
  'code.fail': "That's not passing yet, but let's move on for now."
};

export const REACTIONS = ['react.okay', 'react.right', 'react.gotit', 'react.mmhm', 'react.isee', 'react.thanks'];
export const CONTINUES = ['cont.goon', 'cont.time', 'cont.goahead', 'cont.listening', 'cont.norush', 'cont.withyou'];
export const REPEATS   = ['repeat.1', 'repeat.2', 'repeat.3'];
export const SKIP_ACKS = ['skip.noworries', 'skip.fair', 'skip.fine', 'skip.okay'];
export const TRANSITIONS = { resume: 'trans.resume', technical: 'trans.technical', behavioral: 'trans.behavioral', closing: 'trans.closing' };

export const lib = key => {
  if (!LIBRARY[key]) throw new Error(`Unknown library line "${key}"`);
  return { key, text: LIBRARY[key] };
};

export const questionKey = qid => `q.${qid}`;
export const followUpKey = (qid, trigger) => `f.${qid}.${trigger}`;
export const GREETING_KEY = 'greeting';

// The first name as it should be spoken. The voice spells out words in capitals
// ("NITIN" → "N-I-T-I-N") and initials ("R."), so: the first part with at
// least two letters, without symbols, and in normal case unless it was typed
// in mixed case on purpose ("McKenzie").
const TITLES = /^(dr|mr|mrs|ms|miss|prof|er|sri|shri|smt|ca|adv)$/i;
export function spokenFirstName(name) {
  const first = String(name || '').trim().split(/\s+/)
    .map(p => p.replace(/[^\p{L}'-]/gu, ''))
    .find(p => p.replace(/[^\p{L}]/gu, '').length >= 2 && !TITLES.test(p.replace(/[^\p{L}]/gu, ''))) || '';
  // Lower case plus a capital after the first letter means it was typed that way on purpose.
  if (/\p{Ll}/u.test(first) && /\p{Lu}/u.test(first.slice(1))) return first;
  return first.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-');
}

export function greetingText({ candidateName = '', role = '', company = '', minutes = 15 }) {
  const first = spokenFirstName(candidateName);
  const forRole = role ? ` for the ${role} role${company ? ` at ${company}` : ''}` : '';
  return `Hi${first ? ` ${first}` : ''}, good to meet you. I'll be your interviewer today${forRole}, thanks for making the time. `
    + `We've got about ${minutes} minutes together, so I'll keep it moving: a bit about you, then your projects, then a few technical things. `
    + `There's no trick to any of it. Just talk to me like a person, and it's completely fine to pause and think out loud. Okay, let's start.`;
}

// Every clip an interview needs besides the library: [{ key, text }].
export function interviewClips({ questions, greeting }) {
  const clips = [{ key: GREETING_KEY, text: greeting }];
  for (const q of questions) {
    clips.push({ key: questionKey(q.qid), text: q.text });
    for (const [trigger, text] of Object.entries(q.followUps || {})) {
      if (text && String(text).trim()) clips.push({ key: followUpKey(q.qid, trigger), text: String(text).trim() });
    }
  }
  return clips;
}

// The two voices from the environment. The interview uses one of them throughout.
export function voiceConfig() {
  return {
    main  : { role: 'main',   model: process.env.TTS_MAIN_MODEL   || 'hexgrad/kokoro-82m', voice: process.env.TTS_MAIN_VOICE || 'af_heart' },
    backup: { role: 'backup', model: process.env.TTS_BACKUP_MODEL || 'google/gemini-3.8-flash-lite-tts', voice: process.env.TTS_BACKUP_VOICE || '' }
  };
}

export const voiceId = ({ model, voice }) => `${model}|${voice}`;
