import axios from 'axios';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export const MAX_DOC_CHARS = 12000;

// pdf-parse splits words across lines ("perfor-\nmance") and pads with
// spaces. The parsers quote spans back from this text and the validators
// check them against it, so both see the same normalized version.
export function normalizeDocText(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DOC_CHARS);
}

export async function pdfToText(buffer) {
  const data = await pdfParse(buffer);
  return normalizeDocText(data.text);
}

// Profile resumes live on Cloudinary. Only that host is fetched, so a stored
// URL can't be pointed at internal services.
export async function fetchProfileResumeText(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (host !== 'res.cloudinary.com') return null;
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 10 * 1024 * 1024 });
  return pdfToText(Buffer.from(response.data));
}
