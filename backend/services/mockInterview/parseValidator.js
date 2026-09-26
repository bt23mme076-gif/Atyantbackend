// Verifies parser output against the source text and shapes it for
// MockInterview.parsed. Items with spans that aren't in the source are
// dropped rather than trusted, and each drop is logged.

const CLAIM_TYPES = ['metric', 'tech_choice', 'ownership', 'outcome', 'skill_listed'];
const RISKS = ['low', 'medium', 'high'];

const squash = s => (s || '').toLowerCase().replace(/[\s ]+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();

// Models sometimes elide a quote ("Proficiency in ... Go"). That still counts
// when every piece appears in the source, in order.
function spanChecker(sourceText) {
  const source = squash(sourceText);
  return span => {
    const pieces = squash(span).split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
    if (!pieces.length) return false;
    // Whole-word matches, so "go" can't match inside "algorithms".
    let from = 0;
    for (const piece of pieces) {
      const escaped = piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g');
      re.lastIndex = from;
      const match = re.exec(source);
      if (!match) return false;
      from = match.index + piece.length;
    }
    return true;
  };
}

export function validateJdParse(raw, { jdText, supportedRoleFamilies }) {
  const dropped = [];
  const inSource = spanChecker(jdText);
  const seen = new Set();

  const keep = (items, label) => (Array.isArray(items) ? items : []).filter(item => {
    if (!item?.id || seen.has(item.id)) { dropped.push(`${label}: missing or duplicate id ${item?.id}`); return false; }
    if (!(item.name || item.fact)) { dropped.push(`${label} ${item.id}: empty`); return false; }
    if (!inSource(item.span)) { dropped.push(`${label} ${item.id}: span not in JD`); return false; }
    seen.add(item.id);
    return true;
  });

  const requiredSkills = keep(raw?.requiredSkills, 'skill').map(s => ({ ...s, required: true }));
  const niceToHave     = keep(raw?.niceToHave, 'skill').map(s => ({ ...s, required: false }));
  const companyContext = keep(raw?.companyContext, 'context');

  const roleFamily = supportedRoleFamilies.includes(raw?.roleFamily) ? raw.roleFamily : 'unsupported';
  const seniority  = ['intern', 'fresher', 'experienced'].includes(raw?.seniority) ? raw.seniority : 'fresher';

  return {
    meta: { company: raw?.company || '', role: raw?.role || '', seniority, roleFamily },
    jd  : {
      requiredSkills,
      niceToHave,
      responsibilities: (raw?.responsibilities || []).slice(0, 6),
      companyContext
    },
    dropped
  };
}

export function validateResumeParse(raw, { resumeText, jdSkills }) {
  const dropped = [];
  const inSource = spanChecker(resumeText);

  const projects   = (raw?.projects || []).filter(p => p?.id && p?.name);
  const projectIds = new Set(projects.map(p => p.id));

  const claimIds = new Set();
  const claimSpans = new Set();
  const claims = (raw?.claims || []).filter(c => {
    if (!c?.id || claimIds.has(c.id)) { dropped.push(`claim: missing or duplicate id ${c?.id}`); return false; }
    if (claimSpans.has(squash(c.evidenceSpan))) { dropped.push(`claim ${c.id}: same evidence as an earlier claim`); return false; }
    if (!c.claim || !CLAIM_TYPES.includes(c.type) || !RISKS.includes(c.defensibilityRisk)) {
      dropped.push(`claim ${c.id}: missing text, type or risk`);
      return false;
    }
    if (!inSource(c.evidenceSpan)) { dropped.push(`claim ${c.id}: span not in resume`); return false; }
    if (!Array.isArray(c.probeLadder) || c.probeLadder.length < 3) { dropped.push(`claim ${c.id}: probe ladder under 3 rungs`); return false; }
    claimIds.add(c.id);
    claimSpans.add(squash(c.evidenceSpan));
    return true;
  }).map(c => ({ ...c, projectId: projectIds.has(c.projectId) ? c.projectId : null }));

  // A coverage status needs a quote to count; an unquoted "evidenced" becomes "absent".
  const coverage = new Map((raw?.jdCoverage || []).map(c => [c.jdSkillId, c]));
  const matches = [];
  const gaps = [];
  for (const skill of jdSkills) {
    const c = coverage.get(skill.id);
    const found = c && c.status !== 'absent' && inSource(c.span);
    if (c && c.status !== 'absent' && !found) dropped.push(`coverage ${skill.id}: span not in resume, treated as absent`);
    (found ? matches : gaps).push(skill.id);
  }

  return {
    resume: { projects, skills: raw?.skills || [], claims },
    gap   : { matches, gaps },
    dropped
  };
}
