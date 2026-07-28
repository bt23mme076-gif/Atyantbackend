// Deterministic student-job matching. Skill/project tech-stack overlap +
// preferred-role fit against the job title. No LLM call — this only needs
// to be fast and explainable, not semantically clever.

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textContainsSkill(text, skill) {
  const pattern = new RegExp(`\\b${escapeRegExp(skill)}\\b`, 'i');
  return pattern.test(text);
}

export function computeMatchScore(user, job) {
  const userSkills = new Set(
    [
      ...(user.skills || []),
      ...(user.projects || []).flatMap((p) => p.techStack || []),
    ]
      .map((s) => String(s).toLowerCase().trim())
      .filter(Boolean),
  );

  if (userSkills.size === 0) {
    return { score: 0, matchedSkills: [] };
  }

  const jobText = `${job.title || ''} ${job.descriptionText || ''}`.toLowerCase();

  const matchedSkills = [...userSkills].filter((skill) => textContainsSkill(jobText, skill));
  const skillScore = matchedSkills.length / userSkills.size;

  const roleScore = (user.preferredRoles || []).some((role) =>
    String(job.title || '').toLowerCase().includes(String(role).toLowerCase()),
  )
    ? 1
    : 0;

  const score = Math.round((skillScore * 0.7 + roleScore * 0.3) * 100);

  return { score, matchedSkills };
}

export function matchJobsForUser(user, jobs, { minScore = 0 } = {}) {
  return jobs
    .map((job) => ({ job, ...computeMatchScore(user, job) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
