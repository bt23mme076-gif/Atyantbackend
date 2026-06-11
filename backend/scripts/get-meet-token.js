/**
 * One-time script to get a Google OAuth refresh token for atyant.in@gmail.com
 * Run: node backend/scripts/get-meet-token.js
 * It will open a local server, print the auth URL, and capture the code automatically.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

// Credentials come from .env (gitignored) — never hardcode secrets in the repo.
const CLIENT_ID     = process.env.GOOGLE_MEET_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_MEET_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GOOGLE_MEET_CLIENT_ID / GOOGLE_MEET_CLIENT_SECRET missing in .env');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Starting local server on http://localhost:3000 ...');
console.log('\nOpen this URL in your browser (logged into atyant.in@gmail.com):\n');
console.log(authUrl);
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:3000');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.end(`<h2>Error: ${error}</h2><p>Close this tab.</p>`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.end('<h2>Waiting for authorization...</h2>');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    res.end(`
      <html><body style="font-family:monospace;padding:24px;background:#0d1117;color:#c9d1d9">
        <h2 style="color:#3fb950">✅ Authorization successful! Close this tab.</h2>
        <p>The refresh token has been printed in your terminal.</p>
      </body></html>
    `);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ SUCCESS — Update your .env with these values:\n');
    console.log(`GOOGLE_MEET_EMAIL=atyant.in@gmail.com`);
    console.log(`GOOGLE_MEET_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GOOGLE_MEET_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_MEET_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (!tokens.refresh_token) {
      console.log('\n⚠️  No refresh_token returned.');
      console.log('   Go to https://myaccount.google.com/permissions');
      console.log('   Revoke the Atyant app, then run this script again.\n');
    }

    server.close();
    process.exit(0);
  } catch (err) {
    res.end(`<h2>Error: ${err.message}</h2>`);
    console.error('\n❌ Failed to exchange code:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(3000, () => {
  console.log('Waiting for Google to redirect back to http://localhost:3000 ...\n');
});
