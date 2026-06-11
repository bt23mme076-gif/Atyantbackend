import { google } from 'googleapis';
import crypto from 'crypto';

// Build an OAuth2 client from a user's stored Google refresh/access token.
// `clientId`/`clientSecret` default to the login/calendar client (used for
// mentor & student tokens). The central account passes its own client so it
// stays valid even if the login client changes later.
const oauthClientFor = (user, clientId, clientSecret) => {
  if (!user?.refreshToken && !user?.accessToken) return null;
  const client = new google.auth.OAuth2(
    clientId || process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    clientSecret || process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );
  client.setCredentials({
    refresh_token: user.refreshToken || undefined,
    access_token: user.accessToken || undefined,
  });
  return client;
};

// Service-account Calendar client (GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY).
// Always available if those are set — the reliable fallback that needs no
// per-user OAuth token. Cached after first build.
let _saCalendar = null;
const serviceAccountCalendar = () => {
  if (_saCalendar !== null) return _saCalendar || null;
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!client_email || !private_key) { _saCalendar = false; return null; }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email, private_key },
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    _saCalendar = google.calendar({ version: 'v3', auth });
    return _saCalendar;
  } catch (e) {
    console.warn('Service-account calendar init failed:', e.message);
    _saCalendar = false;
    return null;
  }
};

/**
 * Create a Google Calendar event with a Meet link, inviting both parties.
 * Tiered hosts (first that succeeds wins):
 *   1) Central Atyant OAuth account (GOOGLE_MEET_REFRESH_TOKEN) — optional
 *   2) Mentor's connected Google Calendar
 *   3) Service account (GOOGLE_CLIENT_EMAIL/PRIVATE_KEY) — always-on fallback
 *   4) Student's connected Google Calendar
 * Returns { meetLink, eventId, via } or null (caller may use a generic link).
 */
export async function createMeetEvent({ mentor, student, topic, startTime, durationMin = 30 }) {
  if (process.env.GOOGLE_CALENDAR_ENABLED === 'false') return null;

  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  const attendees = [mentor?.email, student?.email].filter(Boolean).map(email => ({ email }));

  const requestBody = {
    summary: `Atyant: ${topic || 'Mentorship Session'}`,
    description: `Atyant mentorship session between ${student?.name || 'student'} and ${mentor?.name || 'mentor'}.`,
    start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
    end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Kolkata' },
    attendees,
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 30 },
        { method: 'popup', minutes: 10 },
      ],
    },
  };

  const insert = async (calendar) => {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'all', // Google also emails both attendees the invite
      requestBody,
    });
    const meetLink =
      res.data.hangoutLink ||
      res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ||
      null;
    return meetLink ? { meetLink, eventId: res.data.id } : null;
  };

  // Central Atyant OAuth account (optional, highest priority if configured)
  const central = (process.env.GOOGLE_MEET_REFRESH_TOKEN || process.env.GOOGLE_MEET_ACCESS_TOKEN)
    ? { email: process.env.GOOGLE_MEET_EMAIL, refreshToken: process.env.GOOGLE_MEET_REFRESH_TOKEN, accessToken: process.env.GOOGLE_MEET_ACCESS_TOKEN }
    : null;

  const strategies = [
    { via: 'atyant-central', get: () => (central ? oauthClientFor(central, process.env.GOOGLE_MEET_CLIENT_ID, process.env.GOOGLE_MEET_CLIENT_SECRET) : null), wrap: (auth) => google.calendar({ version: 'v3', auth }) },
    { via: 'mentor',         get: () => oauthClientFor(mentor),  wrap: (auth) => google.calendar({ version: 'v3', auth }) },
    { via: 'service-account',get: () => serviceAccountCalendar(), wrap: (cal) => cal },
    { via: 'student',        get: () => oauthClientFor(student), wrap: (auth) => google.calendar({ version: 'v3', auth }) },
  ];

  for (const s of strategies) {
    const handle = s.get();
    if (!handle) continue;
    try {
      const result = await insert(s.wrap(handle));
      if (result?.meetLink) {
        console.log(`✅ Meet link created via ${s.via}: ${result.meetLink}`);
        return { ...result, via: s.via };
      }
    } catch (err) {
      console.warn(`Meet generation via ${s.via} failed:`, err.message, err?.response?.data || '');
      // try next tier
    }
  }

  return null; // caller decides on a generic fallback link
}
