// Companies to poll for job postings via each ATS's public board API.
// Greenhouse board token = the slug in boards.greenhouse.io/{token}
// Lever company slug     = the slug in jobs.lever.co/{slug}
//
// There is no discovery endpoint on either platform, so this list is maintained
// by hand. Every entry below was verified to return live postings — adding an
// unknown slug is harmless (the adapter logs and skips it), but verify first
// so the sync log stays clean.

export const GREENHOUSE_BOARD_TOKENS = [
  // India-relevant / India offices
  'postman',
  'phonepe',
  'groww',
  'slice',
  'druva',
  'netradyne',

  // Global product companies (many hire in India / remote)
  'stripe',
  'airbnb',
  'gitlab',
  'databricks',
  'anthropic',
  'mongodb',
  'datadog',
  'elastic',
  'twilio',
  'cloudflare',
  'figma',
  'samsara',
  'pinterest',
  'brex',
  'scaleai',
  'robinhood',
  'affirm',
  'flexport',
  'asana',
  'instacart',
  'discord',
  'vercel',
  'webflow',
  'squarespace',
  'doximity',
  // Not linked from razorpay.com/careers/ directly, but the board is live —
  // found via the "SEE ALL JOBS" link on that page.
  'razorpaysoftwareprivatelimited',
];

export const LEVER_COMPANY_SLUGS = [
  'palantir',
  'veeva',
  'spotify',
  'mindtickle',
];

// Companies with no Greenhouse/Lever board — their career page gets scraped
// via firecrawl instead (see JobSyncCron + services/adapters/FirecrawlAdapter).
// autoApplySupported is always false for these: firecrawl only reads listings,
// there's no form-driving adapter for arbitrary custom career sites.
// Verify a URL actually renders job listings (not a "life at company" landing
// page) before adding it — an unverified entry just burns a firecrawl scrape
// every sync for nothing.
export const FIRECRAWL_CAREER_PAGES = [
  { company: 'zerodha', url: 'https://careers.zerodha.com/' },
  { company: 'urbancompany', url: 'https://careers.urbancompany.com' },
  { company: 'unacademy', url: 'https://unacademy.com/careers' },
  // Root meesho.io only teases one CTA link — the actual 49-listing board is
  // on /jobs specifically.
  { company: 'meesho', url: 'https://www.meesho.io/jobs' },
];
