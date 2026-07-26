// Vision extraction for photo/image résumés via Gemini's generateContent API.
// Groq has no vision-capable model on this account (checked live — only text
// models are available), so image résumés go through Gemini instead of the
// shared Groq client. PDF résumés still go through Groq (pdf-parse + text).
//
// Model pinning note: Gemini deprecates dated model names surprisingly fast
// ("no longer available to new users" 404s even for models still listed by
// the discovery endpoint). Use the *-latest alias so this doesn't silently
// break again — see GEMINI_MODEL note below.
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const RESUME_VISION_PROMPT = `You read a photo of an Indian engineering student's résumé/CV and extract structured profile data for a career-matching platform.

CRITICAL RULES:
- Use ONLY facts visibly present in the image. If the image isn't a résumé/CV, or text is unreadable, return every field null/[].
- If a field isn't stated, its value MUST be null (or [] for arrays). NEVER guess, infer, or invent a college, CGPA, or number.
- Most résumés do NOT state a career goal, timeline, or constraints directly — leave those null/[] unless genuinely present.

Return ONLY a JSON object with exactly these keys:
{
  "college": null,
  "collegeType": null,
  "branch": null,
  "year": null,
  "cgpa": null,
  "target": null,
  "timeline": null,
  "gap": [],
  "constraint": []
}`;

// Returns the raw parsed JSON object (same flat shape the Groq extractor
// returns), or null on failure/unreadable image. Caller maps it through the
// same extractionToContext() used for the text path.
export async function extractResumeFromImage(base64Data, mimeType, { timeoutMs = 20000 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: RESUME_VISION_PROMPT },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
