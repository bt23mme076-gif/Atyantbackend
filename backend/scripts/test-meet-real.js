/**
 * Calls the REAL createMeetEvent() with attendees + sendUpdates:'all',
 * but with a mentor/student that have NO Google tokens — so ONLY the
 * atyant-central strategy can run. If it fails, the warning (with full
 * error detail) tells us exactly why bookings fall back to aryan.
 *
 * Run from backend dir:  node scripts/test-meet-real.js
 */
import 'dotenv/config';
import { createMeetEvent } from '../utils/googleMeet.js';

const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

const result = await createMeetEvent({
  mentor:  { name: 'Test Mentor',  email: 'atyant.in@gmail.com' }, // NO refreshToken/accessToken
  student: { name: 'Test Student', email: 'nitinrai.test@gmail.com' }, // NO token
  topic: 'Resume review',
  startTime: start,
  durationMin: 45,
});

console.log('\n── RESULT ──');
console.log(result);
if (result?.via === 'atyant-central') {
  console.log('\n✅ central strategy works WITH attendees. Booking should show atyant.in.');
} else {
  console.log('\n❌ central did NOT win. via =', result?.via, '(see warnings above for why)');
}
process.exit(0);
