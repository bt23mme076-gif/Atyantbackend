// ─────────────────────────────────────────────────────────────────────────────
//  Discover which companies have a live public job board on Greenhouse, Lever
//  or Ashby, and how many of their openings are in India.
//
//  None of these platforms has a company directory, so we probe candidate
//  slugs against their public job-board APIs (the same ones the sync uses).
//
//  USAGE (from backend/ folder):
//    node scripts/discoverBoards.js                   # probe the built-in list
//    node scripts/discoverBoards.js --out=found.json  # also write results
//    node scripts/discoverBoards.js razorpay cred     # probe only these names
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import fs from 'fs';
import { GREENHOUSE_BOARD_TOKENS, LEVER_COMPANY_SLUGS } from '../config/atsCompanies.js';

const INDIA = /\b(india|bengaluru|bangalore|pune|mumbai|hyderabad|gurgaon|gurugram|delhi|noida|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|coimbatore|thiruvananthapuram|trivandrum)\b/i;

// Indian startups and companies with large India engineering offices. Slugs are guesses.
const CANDIDATES = `
cred paytm zerodha upstox jupiter fi navi kreditbee moneyview lendingkart zeta juspay cashfree pinelabs
billdesk mobikwik bharatpe okcredit khatabook open policybazaar acko digit coinswitch coindcx smallcase
indmoney stockgro dhan angelone fisdom kuvera scripbox credavenue perfios signzy setu decentro lentra yubi
flipkart myntra meesho nykaa ajio tatacliq firstcry lenskart bewakoof boat mamaearth purplle licious
bigbasket swiggy zomato blinkit zepto dunzo dealshare udaan jumbotail shiprocket delhivery xpressbees
porter rapido ola olaelectric ather cars24 spinny cardekho droom redbus ixigo makemytrip cleartrip yatra
oyo treebo zostel freshworks zoho chargebee browserstack clevertap moengage webengage netcore leadsquared
haptik yellowai uniphore sprinklr innovaccer whatfix darwinbox keka greythr gupshup exotel ozonetel
kissflow zenoti capillary ninjacart icertis amagi observeai hasura sarvam krutrim unacademy byjus
physicswallah upgrad scaler simplilearn vedantu toppr cuemath eruditus practo pharmeasy tata1mg netmeds
healthifyme curefit mfine ekacare qure dream11 dreamsports mpl games24x7 nazara sharechat josh dailyhunt
inshorts pocketfm kuku glance agnikul skyroot pixxel zetwerk atlassian uber nutanix zscaler thoughtspot
cloudera dataiku snyk harness jfrog sentry amplitude mixpanel segment toast rippling deel remote oyster
gusto plaid chime coinbase kraken gemini circle chainalysis okta crowdstrike snowflake confluent hashicorp
github grafana newrelic splunk sumologic walmartglobaltech target wayfair expedia ebay paypal intuit adobe
autodesk ansys synopsys cadence qualcomm nvidia amd intel micron lenovo sprinto spyne rocketlane postman
bitsilica mfine mindtickle zluri atlan clevertap freshdesk razorpay gojek grab sea shopee agoda tokopedia
swiggyinstamart rebel rebelfoods eatfit cure licious wakefit sleepycat pepperfry urbanladder livspace
homelane designcafe nobroker magicbricks housing squareyards proptiger cityflo bounce yulu vogo zoomcar
revv drivezy getmyuni collegedunia shiksha leverage leverageedu sunstone masaischool newtonschool coding
ninjas codingninjas geeksforgeeks interviewbit pwskills apnacollege internshala naukri foundit shine
instahyre cutshort hirist wellfound unstop skillenza hackerearth hackerrank codechef leetcode
`.split(/\s+/).filter(Boolean);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outFile = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const names = [...new Set(args.length ? args : CANDIDATES)];

const known = new Set([...GREENHOUSE_BOARD_TOKENS, ...LEVER_COMPANY_SLUGS]);
const variants = (n) => [n, `${n}hq`, `${n}india`];

async function getJson(url, params) {
  try {
    const res = await axios.get(url, { params, timeout: 15_000, validateStatus: (s) => s === 200 || s === 404 });
    return res.status === 200 ? res.data : null;
  } catch {
    return null;
  }
}

const loc = (v) => (typeof v === 'string' ? v : v?.name || '');

const PLATFORMS = {
  greenhouse: async (slug) => {
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    const jobs = d?.jobs;
    return Array.isArray(jobs) ? jobs.map((j) => loc(j.location)) : null;
  },
  lever: async (slug) => {
    const d = await getJson(`https://api.lever.co/v0/postings/${slug}`, { mode: 'json' });
    return Array.isArray(d) ? d.map((p) => p.categories?.location || '') : null;
  },
  ashby: async (slug) => {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    const jobs = d?.jobs;
    return Array.isArray(jobs) ? jobs.map((j) => [j.location, ...(j.secondaryLocations || []).map(loc)].filter(Boolean).join(' | ')) : null;
  },
};

async function probe(name) {
  const hits = [];
  for (const slug of variants(name)) {
    for (const [platform, fn] of Object.entries(PLATFORMS)) {
      const locations = await fn(slug);
      if (locations && locations.length) {
        hits.push({ platform, slug, total: locations.length, india: locations.filter((l) => INDIA.test(l)).length });
      }
    }
  }
  return hits;
}

const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < names.length) {
    const name = names[cursor++];
    const hits = await probe(name);
    results.push(...hits);
    if (hits.length) console.log(hits.map((h) => `${h.platform.padEnd(10)} ${h.slug.padEnd(24)} ${String(h.india).padStart(4)} India / ${h.total} total`).join('\n'));
  }
}));

results.sort((a, b) => b.india - a.india);
const withIndia = results.filter((r) => r.india > 0);
console.log(`\n${names.length} names probed → ${results.length} live boards, ${withIndia.length} with India jobs (${withIndia.reduce((s, r) => s + r.india, 0)} India openings)`);
console.log('Already synced:', results.filter((r) => known.has(r.slug)).map((r) => r.slug).join(', ') || 'none');
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
