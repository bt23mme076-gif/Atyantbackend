import { groqChat } from '../utils/groqClient.js';

const SYSTEM_PROMPT = `Write a concise, specific cover letter (180-220 words) for an engineering student applying to a job.
No generic filler ("I am writing to express my interest..."), no clichés, no placeholders.
Ground every claim in the candidate's actual skills/projects below — never invent experience they don't have.
Plain text only, no markdown, no subject line, no address block. Sign off with just the candidate's first name.`;

export async function generateCoverLetter({ user, job }) {
  const skills = (user.skills || []).slice(0, 10).join(', ');
  const projects = (user.projects || [])
    .slice(0, 3)
    .map((p) => `${p.title}: ${p.description}`)
    .join('\n');
  const edu = user.education?.[0];
  const education = edu ? `${edu.degree || ''} in ${edu.field || ''}, ${edu.institution || edu.institutionName || ''}` : '';

  const prompt = `Candidate: ${user.name || 'Candidate'}
Education: ${education}
Skills: ${skills || 'none listed'}
Projects:
${projects || 'none listed'}

Job: ${job.title} at ${job.company}
Job description (excerpt): ${(job.descriptionText || '').slice(0, 1500)}

Write the cover letter now.`;

  const text = await groqChat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.6, maxTokens: 500 },
  );

  return text.trim();
}
