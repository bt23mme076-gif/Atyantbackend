// backend/utils/keywordExtractor.js
const stopWords = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'for', 'to', 'of',
  'i', 'me', 'my', 'you', 'your', 'he', 'she', 'it', 'we', 'they', 'what', 'who',
  'when', 'where', 'why', 'how', 'do', 'does', 'did', 'about', 'can', 'should'
]);

export const extractKeywords = (question) => {
  if (!question) return [];

  const words = question
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .split(/\s+/); // Split into words

  return words.filter(word => word && !stopWords.has(word));
};