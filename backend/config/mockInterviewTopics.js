// Topic sheets for the mock interview planner.
//
// A role family is supported only once its sheet has topics. Until then JDs
// in that family get the no-technical-phase interview (extra resume questions).
//
// Topic shape, written by seniors:
//   { id: 'sde.dbms.indexing', name: 'Database indexing',
//     mustKnow: ['B-tree vs hash index', 'composite index column order', ...] }

export const ROLE_FAMILIES = {
  sde : { label: 'Software Engineering', topics: [] },
  data: { label: 'Data / Analytics / ML', topics: [] },
  hr  : { label: 'HR / People', topics: [] }
};

export const SUPPORTED_ROLE_FAMILIES = Object.keys(ROLE_FAMILIES).filter(k => ROLE_FAMILIES[k].topics.length);

export function getRoleFamilySheet(roleFamily) {
  const family = ROLE_FAMILIES[roleFamily];
  return family?.topics.length ? { id: roleFamily, label: family.label, topics: family.topics } : null;
}

export const CORE_TOPICS = [
  { id: 'core.intro',             name: 'Tell me about yourself' },
  { id: 'core.why_company',       name: 'Why this company' },
  { id: 'core.why_role',          name: 'Why this role' },
  { id: 'core.conflict',          name: 'Disagreement or conflict with a teammate' },
  { id: 'core.failure',           name: 'A failure or mistake and what changed after' },
  { id: 'core.pressure',          name: 'Working under a tight deadline' },
  { id: 'core.ownership',         name: 'Taking ownership beyond your assigned work' },
  { id: 'core.learning',          name: 'Learning something new quickly' },
  { id: 'core.strengths',         name: 'Strengths and weaknesses, with evidence' },
  { id: 'core.questions_for_us',  name: 'Do you have any questions for us?' }
];
