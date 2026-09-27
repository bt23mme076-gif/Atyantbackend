// Topic sheets for the mock interview planner.
//
// A role family is supported only once its sheet has topics. Until then JDs
// in that family get the no-technical-phase interview (extra resume questions).
//
// Topic shape, written by seniors:
//   { id: 'sde.dbms.indexing', name: 'Database indexing',
//     mustKnow: ['B-tree vs hash index', 'composite index column order', ...] }

export const ROLE_FAMILIES = {
  sde: {
    label: 'Software Engineering',
    topics: [
      { id: 'sde.dsa', name: 'Data structures and algorithms', mustKnow: ['complexity', 'arrays and strings', 'trees or graphs'] },
      { id: 'sde.dbms', name: 'Databases and SQL', mustKnow: ['joins', 'indexes', 'transactions'] },
      { id: 'sde.backend', name: 'Backend and APIs', mustKnow: ['API design', 'validation', 'failure handling'] },
      { id: 'sde.systems', name: 'Operating systems and networks', mustKnow: ['concurrency', 'HTTP', 'processes'] },
      { id: 'sde.projects', name: 'Project architecture and trade-offs', mustKnow: ['design decisions', 'trade-offs', 'failure modes'] }
    ]
  },
  data: {
    label: 'Data / Analytics / ML',
    topics: [
      { id: 'data.sql', name: 'SQL and data modeling', mustKnow: ['joins', 'aggregation', 'window functions'] },
      { id: 'data.python', name: 'Python for analysis', mustKnow: ['data manipulation', 'clean code', 'validation'] },
      { id: 'data.excel', name: 'Excel and spreadsheet analysis', mustKnow: ['lookups', 'pivot tables', 'error checks'] },
      { id: 'data.bi', name: 'Power BI and reporting', mustKnow: ['data model', 'measures', 'dashboard decisions'] },
      { id: 'data.statistics', name: 'Statistics and experimentation', mustKnow: ['distributions', 'sampling', 'hypothesis testing'] },
      { id: 'data.case', name: 'Business cases and estimation', mustKnow: ['assumptions', 'decomposition', 'recommendation'] },
      { id: 'data.puzzle', name: 'Analytical puzzles', mustKnow: ['logical decomposition', 'stating assumptions out loud', 'sanity-checking the answer'] }
    ]
  },
  consultant: {
    label: 'Consulting / Business Analyst',
    topics: [
      { id: 'consultant.case', name: 'Case studies and business problems', mustKnow: ['problem structuring', 'MECE decomposition', 'recommendation'] },
      { id: 'consultant.guesstimate', name: 'Guesstimates and market sizing', mustKnow: ['assumptions', 'decomposition', 'sanity check'] },
      { id: 'consultant.data_interpretation', name: 'Data interpretation and insights', mustKnow: ['reading charts', 'identifying trends', 'so-what analysis'] },
      { id: 'consultant.sql', name: 'SQL and data querying', mustKnow: ['joins', 'aggregation', 'filtering'] },
      { id: 'consultant.excel', name: 'Excel and spreadsheet modelling', mustKnow: ['lookups', 'pivot tables', 'financial modelling basics'] },
      { id: 'consultant.powerbi', name: 'Dashboards and reporting (Power BI / Tableau)', mustKnow: ['data model', 'KPI selection', 'dashboard design'] }
    ]
  },
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
