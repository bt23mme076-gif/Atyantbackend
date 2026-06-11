/**
 * Directly tests the GOOGLE_MEET_* (central Atyant account) credentials.
 * It tries to create a real calendar event + Meet link using ONLY the
 * central account, and prints the FULL error if it fails.
 *
 * Run from backend dir:  node scripts/test-meet-central.js
 */
import 'dotenv/config';
import { google } from 'googleapis';
import crypto from 'crypto';

const {
  GOOGLE_MEET_EMAIL,
  GOOGLE_MEET_REFRESH_TOKEN,
  GOOGLE_MEET_CLIENT_ID,
  GOOGLE_MEET_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL,
} = process.env;

console.log('\n── Central account config ──');
console.log('EMAIL        :', GOOGLE_MEET_EMAIL);
console.log('CLIENT_ID    :', GOOGLE_MEET_CLIENT_ID);
console.log('CLIENT_SECRET:', GOOGLE_MEET_CLIENT_SECRET ? GOOGLE_MEET_CLIENT_SECRET.slice(0, 12) + '…' : '(missing)');
console.log('REFRESH_TOKEN:', GOOGLE_MEET_REFRESH_TOKEN ? GOOGLE_MEET_REFRESH_TOKEN.slice(0, 14) + '…' : '(missing)');

const client = new google.auth.OAuth2(
  GOOGLE_MEET_CLIENT_ID,
  GOOGLE_MEET_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL
);
client.setCredentials({ refresh_token: GOOGLE_MEET_REFRESH_TOKEN });

(async () => {
  // 1) Can we even get an access token from the refresh token?
  try {
    const { token } = await client.getAccessToken();
    console.log('\n✅ Access token obtained:', token ? token.slice(0, 18) + '…' : '(null)');
  } catch (err) {
    console.error('\n❌ Could NOT get access token (refresh token invalid):');
    console.error('   message:', err.message);
    console.error('   detail :', JSON.stringify(err?.response?.data || {}, null, 2));
    process.exit(1);
  }

  // 2) Who does Google think we are?
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    console.log('✅ Token belongs to:', me.data.email);
    if (me.data.email !== GOOGLE_MEET_EMAIL) {
      console.log(`⚠️  Token email (${me.data.email}) != GOOGLE_MEET_EMAIL (${GOOGLE_MEET_EMAIL})`);
    }
  } catch (err) {
    console.warn('⚠️  Could not fetch userinfo:', err.message);
  }

  // 3) Try to actually create a Meet event (this is what booking does)
  const calendar = google.calendar({ version: 'v3', auth: client });
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  try {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'none',
      requestBody: {
        summary: 'Atyant TEST — central account check',
        start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
        end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Kolkata' },
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    const link = res.data.hangoutLink ||
      res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;
    console.log('\n✅✅ SUCCESS — central account CAN create Meet links.');
    console.log('   Organizer :', res.data.organizer?.email);
    console.log('   Meet link :', link);
    console.log('   Event id  :', res.data.id);
    console.log('\n   The central account works. If bookings still show aryan,');
    console.log('   the backend was not restarted after editing .env.');
    // clean up the test event
    await calendar.events.delete({ calendarId: 'primary', eventId: res.data.id, sendUpdates: 'none' });
    console.log('   (test event deleted)');
  } catch (err) {
    console.error('\n❌ central account FAILED to create event:');
    console.error('   message:', err.message);
    console.error('   detail :', JSON.stringify(err?.response?.data || {}, null, 2));
    console.error('\n   ↳ This is why bookings fall back to the mentor (aryan) calendar.');
  }
})();
