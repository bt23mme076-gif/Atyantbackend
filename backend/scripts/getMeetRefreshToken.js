/**
 * ONE-TIME setup: get a Google refresh token for the CENTRAL Atyant account
 * used to auto-generate Google Meet links for every booking.
 *
 * Steps:
 *  1. In Google Cloud Console → your OAuth client (GOOGLE_CALENDAR_CLIENT_ID),
 *     add this Authorized redirect URI:  http://localhost:5055/oauth2callback
 *  2. Run:  node scripts/getMeetRefreshToken.js
 *  3. Open the printed URL, sign in with the ATYANT account you want to host
 *     all the meetings (e.g. meetings@atyant.in), and approve calendar access.
 *  4. Copy the printed values into your .env:
 *        GOOGLE_MEET_EMAIL=meetings@atyant.in
 *        GOOGLE_MEET_REFRESH_TOKEN=<printed token>
 *  5. Restart the server. Done — Meet links now generate for all bookings.
 */
import 'dotenv/config';
import http from 'http';
import { google } from 'googleapis';

const PORT = 5055;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh_token even if previously authorized
  scope: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');

  if (err) {
    res.writeHead(400); res.end(`Authorization failed: ${err}`);
    console.error('❌ Authorization failed:', err);
    server.close(); process.exit(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Fetch the authorized account's email for convenience
    let email = '';
    try {
      const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 });
      const me = await oauth2api.userinfo.get();
      email = me.data.email || '';
    } catch { /* non-fatal */ }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Done! Copy the values from your terminal into .env, then close this tab.</h2>');

    console.log('\n──────────────────────────────────────────────');
    console.log('✅ Add these to your backend .env:\n');
    if (email) console.log(`GOOGLE_MEET_EMAIL=${email}`);
    if (tokens.refresh_token) {
      console.log(`GOOGLE_MEET_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      console.log('⚠️  No refresh_token returned. Revoke prior access at');
      console.log('    https://myaccount.google.com/permissions and run again.');
    }
    console.log('──────────────────────────────────────────────\n');
  } catch (e) {
    res.writeHead(500); res.end('Token exchange failed: ' + e.message);
    console.error('❌ Token exchange failed:', e.message);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(PORT, () => {
  console.log('\n1) Make sure this redirect URI is registered in your Google OAuth client:');
  console.log(`   ${REDIRECT_URI}\n`);
  console.log('2) Open this URL, sign in as the central Atyant account, and approve:\n');
  console.log('   ' + authUrl + '\n');
  console.log('Waiting for authorization...');
});
