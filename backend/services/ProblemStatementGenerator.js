// ─────────────────────────────────────────────
//  PROBLEM STATEMENT GENERATOR
//
//  Turns the 5-layer context extracted during the AI conversation
//  into a structured problem statement the matching engine can process.
//
//  Output format:
//    Student: VNIT Nagpur | Metallurgy | Year 3 | CGPA 7.2
//    Goal: AI/ML internship at product startup
//    Gap: Zero coding background, no relevant projects
//    Timeline: 5 months
//    Constraint: No paid resources, no CS peers
//    Confidence: High (all 5 layers extracted)
//
//  The 5 layers:
//    1. Identity   — college, branch, year, cgpa
//    2. Target     — goal
//    3. Gap        — what's blocking them
//    4. Timeline   — how long they have
//    5. Constraint — hard limits
// ─────────────────────────────────────────────

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'none' || s.toLowerCase() === 'n/a') return null;
  return s;
}

/**
 * Merge conversational extraction with the stored profile.
 * Conversation wins; profile fills the gaps so the engine never
 * loses identity data the student already provided at signup.
 */
function resolveIdentity(extracted = {}, profile = null) {
  const edu = profile?.education?.[0] || {};
  return {
    college: clean(extracted.college) || clean(edu.institutionName) || clean(edu.institution),
    branch:  clean(extracted.branch)  || clean(edu.field),
    year:    clean(extracted.year)    || clean(edu.year),
    cgpa:    clean(extracted.cgpa)    || clean(edu.cgpa),
  };
}

/**
 * Count how many of the 5 layers are present.
 * Identity counts as filled if ANY of college/branch/year exists
 * (cgpa is a bonus signal, not required to count the layer).
 */
function countLayers(identity, target, gap, timeline, constraint) {
  let n = 0;
  if (identity.college || identity.branch || identity.year) n++;
  if (target)     n++;
  if (gap)        n++;
  if (timeline)   n++;
  if (constraint) n++;
  return n;
}

function confidenceLabel(layers) {
  if (layers >= 5) return { level: 'High',   note: 'all 5 layers extracted' };
  if (layers >= 3) return { level: 'Medium', note: `${layers}/5 layers extracted` };
  return { level: 'Low', note: `${layers}/5 layers extracted` };
}

function listMissing(identity, target, gap, timeline, constraint) {
  const missing = [];
  if (!(identity.college || identity.branch || identity.year)) missing.push('identity');
  if (!target)     missing.push('target');
  if (!gap)        missing.push('gap');
  if (!timeline)   missing.push('timeline');
  if (!constraint) missing.push('constraint');
  return missing;
}

/**
 * Build the structured problem statement.
 *
 * @param {Object} extracted - { college, branch, year, cgpa, goal, gap, timeline, constraints }
 * @param {Object|null} profile - optional User doc for identity fallback
 * @returns {{ statement: string, confidence: string, layersFilled: number, missing: string[], structured: Object }}
 */
export function generateProblemStatement(extracted = {}, profile = null) {
  const identity   = resolveIdentity(extracted, profile);
  const target     = clean(extracted.goal) || clean(extracted.target);
  const gap        = clean(extracted.gap);
  const timeline   = clean(extracted.timeline);
  const constraint = clean(extracted.constraints) || clean(extracted.constraint);

  const layers = countLayers(identity, target, gap, timeline, constraint);
  const { level, note } = confidenceLabel(layers);

  // ── Build the human-readable statement ──
  // `lines` is the clean brief the engine matches on and the mentor reads.
  // The Confidence line is internal metadata — appended only to `statement`.
  const lines = [];

  const idParts = [identity.college, identity.branch,
    identity.year ? `Year ${identity.year}` : null,
    identity.cgpa ? `CGPA ${identity.cgpa}` : null,
  ].filter(Boolean);

  if (idParts.length) lines.push(`Student: ${idParts.join(' | ')}`);
  if (target)         lines.push(`Goal: ${target}`);
  if (gap)            lines.push(`Gap: ${gap}`);
  if (timeline)       lines.push(`Timeline: ${timeline}`);
  if (constraint)     lines.push(`Constraint: ${constraint}`);

  const engineText = lines.join('\n');
  const confidenceLine = `Confidence: ${level} (${note})`;

  return {
    // Clean brief → goes to the engine as questionText, shown to the mentor
    engineText,
    // Full statement with confidence → internal/debug/frontend display
    statement: `${engineText}\n${confidenceLine}`,
    confidence: level,
    layersFilled: layers,
    missing: listMissing(identity, target, gap, timeline, constraint),
    structured: { identity, target, gap, timeline, constraint },
  };
}

/**
 * Is the context rich enough to send to the matching engine?
 * Engine needs identity + target at minimum (2 layers), 3+ preferred.
 */
export function isEngineReady(extracted = {}, profile = null) {
  const { layersFilled, structured } = generateProblemStatement(extracted, profile);
  const hasIdentity = !!(structured.identity.college || structured.identity.branch || structured.identity.year);
  const hasTarget = !!structured.target;
  return hasIdentity && hasTarget && layersFilled >= 2;
}

export default generateProblemStatement;
