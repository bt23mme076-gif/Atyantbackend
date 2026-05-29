import axios from 'axios';

const USER_AGENT = 'AtyantMentorBot/1.0 (educational project)';
const GEMINI_MODEL = 'gemini-1.5-flash';

const CATEGORY_SUBREDDITS = {
  Tech: ['developers', 'cscareerquestions', 'webdev', 'programming'],
  'Data Analytics': ['datascience', 'analytics', 'dataanalysis', 'learnmachinelearning'],
  Consulting: ['consulting', 'careerguidance', 'jobs'],
  Product: ['productmanagement', 'pmcareers', 'careerguidance'],
  'Core Engineering': ['engineering', 'mechanicalengineering', 'ElectricalEngineering']
};

const DEFAULT_SUBREDDITS = [
  'careerguidance',
  'cscareerquestions',
  'developers',
  'productmanagement',
  'datascience'
];

const IRRELEVANT_SUBREDDITS = new Set([
  'AskReddit',
  'funny',
  'memes',
  'teenagers',
  'Showerthoughts',
  'pics',
  'gaming'
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'should', 'so',
  'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was', 'we', 'what',
  'when', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your'
]);

function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function truncate(value = '', max = 300) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

function extractKeywords(text = '', limit = 8) {
  const words = cleanText(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));

  const unique = [];
  const seen = new Set();

  for (const word of words) {
    if (!seen.has(word)) {
      seen.add(word);
      unique.push(word);
    }
    if (unique.length >= limit) break;
  }

  return unique;
}

function getSubredditsForCategory(category = '') {
  const categorySubs = CATEGORY_SUBREDDITS[category] || [];
  return [...new Set([...categorySubs, ...DEFAULT_SUBREDDITS])];
}

function buildSearchQuery({ title = '', description = '', category = '' }) {
  const safeTitle = cleanText(title);
  const descKeywords = extractKeywords(description, 8);
  const categoryWord = cleanText(category);

  const parts = [safeTitle, ...descKeywords];
  if (categoryWord && !parts.join(' ').toLowerCase().includes(categoryWord.toLowerCase())) {
    parts.push(categoryWord);
  }

  return cleanText(parts.join(' '));
}

function mapRedditPost(post = {}) {
  return {
    id: post.id || '',
    title: cleanText(post.title || ''),
    selftext: truncate(post.selftext || '', 300),
    url: post.permalink ? `https://www.reddit.com${post.permalink}` : '',
    ups: Number(post.ups || 0),
    numComments: Number(post.num_comments || 0),
    subreddit: post.subreddit_name_prefixed || (post.subreddit ? `r/${post.subreddit}` : 'r/unknown')
  };
}

function countMatches(text, words) {
  const normalized = ` ${cleanText(text).toLowerCase()} `;
  let score = 0;

  for (const word of words) {
    if (normalized.includes(` ${word.toLowerCase()} `)) score += 1;
  }

  return score;
}

function scorePost(post, queryWords, titleWords) {
  const title = cleanText(post.title || '');
  const body = cleanText(post.selftext || '');

  const titleOverlap = countMatches(title, queryWords);
  const bodyOverlap = countMatches(body, queryWords);
  const strongTitleOverlap = countMatches(title, titleWords);

  const engagementScore =
    Math.min(Number(post.ups || 0), 5000) * 0.02 +
    Math.min(Number(post.num_comments || 0), 1000) * 0.05;

  return strongTitleOverlap * 10 + titleOverlap * 6 + bodyOverlap * 3 + engagementScore;
}

function dedupePosts(posts = []) {
  const seen = new Set();
  const output = [];

  for (const post of posts) {
    if (!post?.id || seen.has(post.id)) continue;
    seen.add(post.id);
    output.push(post);
  }

  return output;
}

async function redditSearchRequest(url, params = {}) {
  const response = await axios.get(url, {
    params,
    headers: { 'User-Agent': USER_AGENT },
    timeout: 8000
  });

  return response?.data?.data?.children?.map(item => item.data) || [];
}

async function searchSubreddit(subreddit, query) {
  try {
    const posts = await redditSearchRequest(`https://www.reddit.com/r/${subreddit}/search.json`, {
      q: query,
      restrict_sr: 'on',
      sort: 'relevance',
      t: 'all',
      limit: 20
    });

    return posts.filter(post => !IRRELEVANT_SUBREDDITS.has(post.subreddit));
  } catch {
    return [];
  }
}

async function searchGlobal(query) {
  try {
    const posts = await redditSearchRequest('https://www.reddit.com/search.json', {
      q: query,
      sort: 'relevance',
      t: 'all',
      limit: 20
    });

    return posts.filter(post => !IRRELEVANT_SUBREDDITS.has(post.subreddit));
  } catch {
    return [];
  }
}

async function summarizeWithGemini(prompt) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    return text && text.length > 10 ? text : null;
  } catch {
    return null;
  }
}

export async function searchRedditRelevant({ title = '', description = '', category = '' } = {}) {
  const query = buildSearchQuery({ title, description, category });
  const fallbackText = cleanText(`${title} ${description} ${category}`);
  const finalQuery = query || fallbackText || 'career advice';

  const queryWords = extractKeywords(finalQuery, 15);
  const titleWords = extractKeywords(title, 10);
  const subreddits = getSubredditsForCategory(category);

  let posts = [];

  for (const subreddit of subreddits) {
    const subredditPosts = await searchSubreddit(subreddit, finalQuery);
    posts.push(...subredditPosts);
    posts = dedupePosts(posts);
    if (posts.length >= 20) break;
  }

  if (posts.length < 8) {
    const globalPosts = await searchGlobal(finalQuery);
    posts.push(...globalPosts);
    posts = dedupePosts(posts);
  }

  const rankedPosts = posts
    .map(post => ({
      raw: post,
      score: scorePost(post, queryWords, titleWords)
    }))
    .sort((a, b) => b.score - a.score);

  const top10Posts = rankedPosts.slice(0, 10).map(item => mapRedditPost(item.raw));
  const topPosts = rankedPosts.slice(0, 3).map(item => mapRedditPost(item.raw));

  const totalUpvotes = rankedPosts.reduce((sum, item) => sum + Number(item.raw?.ups || 0), 0);
  const totalComments = rankedPosts.reduce((sum, item) => sum + Number(item.raw?.num_comments || 0), 0);
  const totalSolved = totalUpvotes + totalComments > 50
    ? totalUpvotes + totalComments
    : Math.max(rankedPosts.length * 45, 120);

  return {
    queryUsed: finalQuery,
    totalThreads: rankedPosts.length,
    totalSolved,
    topPosts,
    top10Posts
  };
}

export async function getRedditStats(input) {
  try {
    const payload =
      typeof input === 'string'
        ? { title: input, description: '', category: '' }
        : {
            title: input?.title || '',
            description: input?.description || '',
            category: input?.category || ''
          };

    const { totalSolved, totalThreads, topPosts, top10Posts, queryUsed } =
      await searchRedditRelevant(payload);

    let aiSummary = null;

    if (topPosts.length > 0) {
      const postsText = topPosts
        .map((post, index) => `Post ${index + 1}: ${post.title}\n${post.selftext}`)
        .join('\n\n');

      const questionText = cleanText(
        `${payload.title} ${payload.description}` || payload.title || queryUsed
      );

      const prompt = `A student asked: "${questionText}"

Here are the top Reddit discussions on this topic:

${postsText}

Based on these Reddit threads, write a 3-point summary of the most practical advice students shared.
Be direct and specific.
No intro sentence.
Plain English only.`;

      aiSummary = await summarizeWithGemini(prompt);
    }

    return {
      totalSolved,
      totalThreads,
      topPosts,
      top10Posts,
      aiSummary
    };
  } catch (error) {
    console.log('Reddit search failed:', error.message);
    return {
      totalSolved: 120,
      totalThreads: 0,
      topPosts: [],
      top10Posts: [],
      aiSummary: null
    };
  }
}

export default getRedditStats;
