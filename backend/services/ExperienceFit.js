// Experience-level fit between a job and a student. Deterministic, like the
// skill matcher: most postings say what they need in the title ("Intern",
// "New Grad", "Senior") or in a "5+ years of experience" line, and most Atyant
// users are current students with no full-time experience — so a strong skill
// overlap on a "10+ years" role is not a real match.

const INTERN = /\b(intern(ship)?s?|co-?op|apprentice(ship)?|trainee|summer analyst)\b/i;
const ENTRY = /\b(new grads?|graduate|entry[- ]level|junior|jr\.?|early[- ]career|fresher|campus|university grad|associate|20\d\d (start|grads?|graduates?|batch))\b/i;
const NOT_ENTRY = /\bassociate (director|manager|partner|principal|vice president|general counsel)\b|\bgraduate (researcher|student researcher)\b/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|head of|director|vp|vice president|architect|chief)\b/i;
const MANAGER = /\bmanager\b/i;
const JUNIOR_MANAGER = /\b(assistant|associate) manager\b/i;

// "5+ years", "3-5 years", "minimum 2 years" — only when tied to experience, and only plausible numbers.
const YEARS = /(\d{1,2})\s*\+?\s*(?:(?:-|–|—|to)\s*\d{1,2}\s*)?\+?\s*years?\b(?:[^.\n]{0,60}?)\bexperience/gi;
const YEARS_REV = /experience[^.\n]{0,40}?\b(?:of|minimum|at least)?\s*(\d{1,2})\s*\+?\s*years?\b/gi;

export function minYearsFromText(text = '') {
  const found = [];
  for (const re of [YEARS, YEARS_REV]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && found.length < 10) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 20) found.push(n);
    }
  }
  return found.length ? Math.min(...found) : null;
}

/** { experienceLevel: internship|entry|mid|senior|unknown, minYears: number|null } */
export function classifyJob(job) {
  const title = String(job.title || '');
  const minYears = minYearsFromText(String(job.descriptionText || '').slice(0, 20000));

  if (INTERN.test(title)) return { experienceLevel: 'internship', minYears: 0 };
  if (ENTRY.test(title) && !NOT_ENTRY.test(title) && !SENIOR.test(title)) {
    return { experienceLevel: 'entry', minYears: minYears !== null && minYears <= 2 ? minYears : 0 };
  }
  if (SENIOR.test(title)) return { experienceLevel: 'senior', minYears: Math.max(minYears ?? 5, 3) };
  if (MANAGER.test(title) && !JUNIOR_MANAGER.test(title)) {
    const y = minYears ?? 4;
    return { experienceLevel: y >= 5 ? 'senior' : 'mid', minYears: y };
  }
  if (minYears === null) return { experienceLevel: 'unknown', minYears: null };
  if (minYears <= 1) return { experienceLevel: 'entry', minYears };
  return { experienceLevel: minYears >= 5 ? 'senior' : 'mid', minYears };
}

export function experienceLabel({ experienceLevel, minYears }) {
  switch (experienceLevel) {
    case 'internship': return 'Internship';
    case 'entry': return 'Fresher-friendly';
    case 'mid': return `${minYears}+ yrs experience`;
    case 'senior': return `Senior · ${minYears}+ yrs`;
    default: return 'Experience not stated';
  }
}

// Education "year" is free text in practice: "2nd Year", "4th", "Graduated", "2027".
function educationStage(user, now = new Date()) {
  const raw = String(user.education?.[0]?.year || '').trim().toLowerCase();
  if (!raw) return null;
  if (/grad|alumn|complete|passed/.test(raw)) return { stage: 'graduate' };
  const study = /^(\d)(st|nd|rd|th)?\b/.exec(raw);
  if (study && /year|^\d(st|nd|rd|th)?$/.test(raw)) return { stage: 'student', studyYear: Number(study[1]) };
  const y = /\b(20\d\d)\b/.exec(raw);
  if (y) {
    const gradYear = Number(y[1]);
    // Indian batches graduate around June.
    const graduated = gradYear < now.getFullYear() || (gradYear === now.getFullYear() && now.getMonth() >= 5);
    return graduated ? { stage: 'graduate', gradYear } : { stage: 'student', gradYear };
  }
  return null;
}

/** { stage: student|graduate|unknown, years, finalYear } */
export function userExperience(user, now = new Date()) {
  const months = (user.workExperience || []).reduce((sum, w) => sum + (Number(w.months) || 0), 0);
  const years = Math.max(Number(user.yearsOfExperience) || 0, months / 12);
  const edu = educationStage(user, now);
  if (years >= 1) return { stage: 'graduate', years, finalYear: false };
  if (!edu) return { stage: 'unknown', years, finalYear: false };
  const finalYear = edu.stage === 'student'
    && ((edu.studyYear && edu.studyYear >= 4) || (edu.gradYear && edu.gradYear <= now.getFullYear() + 1));
  return { stage: edu.stage, years, finalYear: !!finalYear };
}

const FIT_WEIGHT = { good: 1, unclear: 0.9, stretch: 0.7, unlikely: 0.35 };

/** { fit: good|stretch|unlikely|unclear, reason } */
export function experienceFit(user, jobLevel) {
  const me = userExperience(user);
  const { experienceLevel: level, minYears } = jobLevel;
  const yrs = Math.floor(me.years);

  if (level === 'unknown') return { fit: 'unclear', reason: "The posting doesn't say how much experience it wants." };

  if (level === 'internship') {
    return me.stage === 'graduate' && me.years >= 1
      ? { fit: 'stretch', reason: 'Internship — usually meant for current students.' }
      : { fit: 'good', reason: 'Internship — open to current students.' };
  }

  if (level === 'entry') {
    if (me.stage === 'student' && !me.finalYear) return { fit: 'stretch', reason: 'Full-time fresher role — usually for final-year students and recent graduates.' };
    return { fit: 'good', reason: 'Fresher-friendly — no prior full-time experience needed.' };
  }

  const need = minYears ?? (level === 'senior' ? 5 : 2);
  const gap = need - yrs;
  if (gap <= 0) return { fit: 'good', reason: `Needs ${need}+ years — you have about ${yrs}.` };
  if (gap === 1 && me.stage === 'graduate') return { fit: 'stretch', reason: `Needs ${need}+ years — you have about ${yrs}. Worth a try if your skills match.` };
  const you = me.stage === 'student' ? "you're still studying" : `you have about ${yrs}`;
  return { fit: 'unlikely', reason: `Needs ${need}+ years of experience — ${you}.` };
}

/** Experience summary for one job, for API responses. User optional. */
export function experienceFor(job, user) {
  const level = job.experienceLevel ? { experienceLevel: job.experienceLevel, minYears: job.minYears ?? null } : classifyJob(job);
  return {
    level: level.experienceLevel,
    minYears: level.minYears,
    label: experienceLabel(level),
    ...(user ? experienceFit(user, level) : {}),
  };
}

export const fitWeight = (fit) => FIT_WEIGHT[fit] ?? 1;
