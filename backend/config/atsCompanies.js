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
];

export const LEVER_COMPANY_SLUGS = [
  'palantir',
  'veeva',
  'spotify',
  'mindtickle',
];
