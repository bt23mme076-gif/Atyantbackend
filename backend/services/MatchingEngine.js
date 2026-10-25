// Deterministic student-job matching. Skill/project tech-stack overlap +
// preferred-role fit against the job title. No LLM call — this only needs
// to be fast and explainable, not semantically clever.

import { experienceFor, fitWeight } from './ExperienceFit.js';
import { locationFit } from './JobLocation.js';

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
    return { score: 0, skillMatch: 0, matchedSkills: [], experience: experienceFor(job, user), locationFit: locationFit(job.location).fit };
  }

  const jobText = `${job.title || ''} ${job.descriptionText || ''}`.toLowerCase();

  const matchedSkills = [...userSkills].filter((skill) => textContainsSkill(jobText, skill));
  const skillScore = matchedSkills.length / userSkills.size;

  const roleScore = (user.preferredRoles || []).some((role) =>
    String(job.title || '').toLowerCase().includes(String(role).toLowerCase()),
  )
    ? 1
    : 0;

  const skillMatch = Math.round((skillScore * 0.7 + roleScore * 0.3) * 100);

  // A strong skill overlap on a role the student can't realistically get
  // (e.g. "8+ years") isn't a match — scale by experience fit.
  const experience = experienceFor(job, user);
  const where = locationFit(job.location);
  const score = Math.round(skillMatch * fitWeight(experience.fit) * where.weight);

  return { score, skillMatch, matchedSkills, experience, locationFit: where.fit };
}

// Roles the student can't realistically get yet ("needs 5+ years") rank after every
// role they can, however strong the skill overlap — then by score.
const unlikely = (m) => (m.experience?.fit === 'unlikely' ? 1 : 0);

export function matchJobsForUser(user, jobs, { minScore = 0 } = {}) {
  return jobs
    .map((job) => ({ job, ...computeMatchScore(user, job) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => unlikely(a) - unlikely(b) || b.score - a.score);
}
