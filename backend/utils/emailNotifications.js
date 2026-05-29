import { Resend } from 'resend';

// ─────────────────────────────────────────────
//  INIT  (single instance, warn if missing)
// ─────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (!resend) {
  console.warn('⚠️  RESEND_API_KEY missing — email notifications disabled');
} else {
  console.log('✅ Resend email service ready');
}

const FROM    = 'Atyant <notification@atyant.in>';
const APP_URL = process.env.FRONTEND_URL || 'https://www.atyant.in';

// ─────────────────────────────────────────────
//  HELPER  — shared send wrapper
// ─────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!resend) return { success: false, error: 'Email service not configured' };
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to: [to], subject, html });
    if (error) {
      console.error('📧 Resend error:', error);
      return { success: false, error: error.message };
    }
    return { success: true, data };
  } catch (err) {
    console.error('📧 Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
//  MENTOR: new question notification
// ─────────────────────────────────────────────
export const sendMentorNewQuestionNotification = async (mentorEmail, mentorName, questionText, keywords = []) => {
  const keywordBadges = keywords.slice(0, 5).map(kw =>
    `<span style="background:#d1fae5;color:#065f46;padding:6px 12px;border-radius:12px;font-size:13px;font-weight:600;display:inline-block;margin:4px">${kw}</span>`
  ).join('');

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#10b981;text-align:center;margin:0 0 30px">🎯 Atyant</h1>
  <div style="background:#f0fdf4;padding:30px;border-radius:10px;border-left:4px solid #10b981">
    <h2 style="color:#1f2937;margin-top:0">New Question Assigned to You!</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${mentorName},</p>
    <p style="color:#6b7280;line-height:1.6">A student asked a question that matches your expertise.</p>
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #10b981">
      <h3 style="color:#10b981;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Question</h3>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0">${questionText}</p>
    </div>
    ${keywordBadges ? `<div style="margin:20px 0"><p style="color:#6b7280;font-size:14px;margin-bottom:8px">Related Topics:</p>${keywordBadges}</div>` : ''}
    <div style="text-align:center;margin:30px 0">
      <a href="${APP_URL}/mentor-dashboard"
         style="background:#10b981;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        Answer Question
      </a>
    </div>
    <div style="background:#fef3c7;padding:15px;border-radius:8px">
      <p style="color:#92400e;margin:0;font-size:13px">💡 <strong>Remember:</strong> Share your real experience — not generic advice.</p>
    </div>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  const result = await sendEmail({ to: mentorEmail, subject: '🎯 New Question Assigned to You', html });
  if (result.success) console.log(`✅ Mentor notification sent → ${mentorEmail}`);
  return result;
};

// ─────────────────────────────────────────────
//  STUDENT: answer ready notification
// ─────────────────────────────────────────────
export const sendUserAnswerReadyNotification = async (userEmail, userName, questionText, isFollowUp = false) => {
  const subject = `✅ Your ${isFollowUp ? 'Follow-up ' : ''}Answer is Ready!`;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#6366f1;text-align:center;margin:0 0 30px">✨ Atyant</h1>
  <div style="background:#ede9fe;padding:30px;border-radius:10px;border-left:4px solid #6366f1">
    <h2 style="color:#1f2937;margin-top:0">🎉 Your Answer is Ready!</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${userName},</p>
    <p style="color:#6b7280;line-height:1.6">A mentor answered your ${isFollowUp ? 'follow-up ' : ''}question based on their real experience.</p>
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #6366f1">
      <h3 style="color:#6366f1;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Your Question</h3>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0">${questionText}</p>
    </div>
    <div style="background:#d1fae5;padding:20px;border-radius:8px;margin:20px 0">
      <p style="color:#065f46;margin:0;font-size:14px">✨ <strong>What you'll get:</strong></p>
      <ul style="color:#065f46;margin:10px 0 0;padding-left:20px">
        <li>Real experience from someone who solved this</li>
        <li>Key mistakes to avoid</li>
        <li>Step-by-step actionable plan</li>
        <li>Realistic timeline and outcomes</li>
      </ul>
    </div>
    <div style="text-align:center;margin:30px 0">
      <a href="${APP_URL}/my-questions"
         style="background:#6366f1;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        View Your Answer
      </a>
    </div>
    <p style="color:#6b7280;font-size:13px;text-align:center">💬 You can ask up to 2 follow-ups on the same answer!</p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  const result = await sendEmail({ to: userEmail, subject, html });
  if (result.success) console.log(`✅ Student notification sent → ${userEmail}`);
  return result;
};

// ─────────────────────────────────────────────
//  MEETING: meeting notification
// ─────────────────────────────────────────────
export const sendMeetingNotification = async (mentorEmail, userEmail, meetingDetails) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#10b981;text-align:center;margin:0 0 30px">📅 Meeting Scheduled</h1>
      <div style="background:#f0fdf4;padding:30px;border-radius:10px;border-left:4px solid #10b981">
        <h2 style="color:#1f2937;margin-top:0">Meeting Details</h2>
        <p style="color:#6b7280;line-height:1.6">Hi,</p>
        <p style="color:#6b7280;line-height:1.6">A new meeting has been scheduled. Here are the details:</p>
        <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #10b981">
          <p><strong>Title:</strong> ${meetingDetails.title}</p>
          <p><strong>Description:</strong> ${meetingDetails.description}</p>
          <p><strong>Start Time:</strong> ${new Date(meetingDetails.startTime).toLocaleString()}</p>
          <p><strong>End Time:</strong> ${new Date(meetingDetails.endTime).toLocaleString()}</p>
          <p><strong>Meeting Link:</strong> <a href="${meetingDetails.meetLink}">${meetingDetails.meetLink}</a></p>
        </div>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
    </div>
  `;

  const mentorResult = await sendEmail({ to: mentorEmail, subject: '📅 New Meeting Scheduled', html });
  const userResult = await sendEmail({ to: userEmail, subject: '📅 New Meeting Scheduled', html });

  if (mentorResult.success) console.log(`✅ Meeting notification sent to mentor → ${mentorEmail}`);
  if (userResult.success) console.log(`✅ Meeting notification sent to user → ${userEmail}`);

  return { mentorResult, userResult };
};
