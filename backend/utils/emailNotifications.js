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

const FROM = 'Atyant <notification@atyant.in>';
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

// ─────────────────────────────────────────────
//  SERVICE PURCHASE: notification to mentor and student
// ─────────────────────────────────────────────
export const sendServicePurchaseNotification = async (mentorEmail, mentorName, mentorId, userEmail, userName, userId, serviceName, sessionDetails = {}) => {
  const mentorHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#6366f1;text-align:center;margin:0 0 30px">💰 New Service Purchase</h1>
  <div style="background:#ede9fe;padding:30px;border-radius:10px;border-left:4px solid #6366f1">
    <h2 style="color:#1f2937;margin-top:0">🎉 New Service Purchased!</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${mentorName},</p>
    <p style="color:#6b7280;line-height:1.6">A student has purchased your <strong>${serviceName}</strong> service.</p>
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #6366f1">
      <h3 style="color:#6366f1;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Student Details</h3>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0"><strong>Name:</strong> ${userName}</p>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0"><strong>Email:</strong> ${userEmail}</p>
    </div>
    ${sessionDetails.scheduledAt ? `
    <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:20px 0">
      <h3 style="color:#10b981;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Scheduled Session</h3>
      <p style="color:#065f46;margin:0;font-size:16px;line-height:1.6"><strong>Date & Time:</strong> ${new Date(sessionDetails.scheduledAt).toLocaleString()}</p>
      <p style="color:#065f46;margin:0;font-size:16px;line-height:1.6"><strong>Topic:</strong> ${sessionDetails.topic || 'Career Guidance'}</p>
    </div>
    ` : ''}
    <div style="background:#d1fae5;padding:20px;border-radius:8px;margin:20px 0">
      <p style="color:#065f46;margin:0;font-size:14px">💬 <strong>Chat Now Available:</strong></p>
      <p style="color:#065f46;margin:0;font-size:14px">You can now chat with this student to discuss their needs and prepare for the session.</p>
    </div>
    <div style="text-align:center;margin:30px 0">
      <a href="${APP_URL}/mentor-dashboard"
         style="background:#6366f1;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        View in Dashboard
      </a>
    </div>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  const studentHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#10b981;text-align:center;margin:0 0 30px">✨ Service Purchased</h1>
  <div style="background:#f0fdf4;padding:30px;border-radius:10px;border-left:4px solid #10b981">
    <h2 style="color:#1f2937;margin-top:0">🎉 Payment Successful!</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${userName},</p>
    <p style="color:#6b7280;line-height:1.6">Your purchase of <strong>${serviceName}</strong> with ${mentorName} is confirmed.</p>
    ${sessionDetails.scheduledAt ? `
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #10b981">
      <h3 style="color:#10b981;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Scheduled Session</h3>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0"><strong>Date & Time:</strong> ${new Date(sessionDetails.scheduledAt).toLocaleString()}</p>
      <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0"><strong>Topic:</strong> ${sessionDetails.topic || 'Career Guidance'}</p>
    </div>
    ` : ''}
    <div style="background:#d1fae5;padding:20px;border-radius:8px;margin:20px 0">
      <p style="color:#065f46;margin:0;font-size:14px">💬 <strong>Chat Now Available:</strong></p>
      <p style="color:#065f46;margin:0;font-size:14px">You can now chat directly with ${mentorName} to discuss your session and any questions.</p>
    </div>
    <div style="text-align:center;margin:30px 0">
      <a href="${APP_URL}/chat"
         style="background:#10b981;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        Start Chat
      </a>
    </div>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  const mentorResult = await sendEmail({ to: mentorEmail, subject: '💰 New Service Purchased', html: mentorHtml });
  const studentResult = await sendEmail({ to: userEmail, subject: '✨ Service Purchased Successfully', html: studentHtml });

  if (mentorResult.success) console.log(`✅ Service purchase notification sent to mentor → ${mentorEmail}`);
  if (studentResult.success) console.log(`✅ Service purchase notification sent to student → ${userEmail}`);

  return { mentorResult, studentResult };
};

// ─────────────────────────────────────────────────────────────────────────────
//  TEXT Q&A: a student bought a chat plan → tell the mentor & deep-link them
//  straight into that student's chat thread (no Google Meet for Text Q&A).
// ─────────────────────────────────────────────────────────────────────────────
export const sendMentorChatRequestNotification = async (mentorEmail, mentorName, studentName, chatUrl) => {
  return sendMentorChatRequestNotificationWithDetails(mentorEmail, mentorName, studentName, chatUrl);
};

export const sendMentorChatRequestNotificationWithDetails = async (mentorEmail, mentorName, studentName, chatUrl, sessionDetails = {}) => {
  const when = sessionDetails.scheduledAt
    ? new Date(sessionDetails.scheduledAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' })
    : null;
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#6366f1;text-align:center;margin:0 0 30px">💬 New Chat Request</h1>
  <div style="background:#ede9fe;padding:30px;border-radius:10px;border-left:4px solid #6366f1">
    <h2 style="color:#1f2937;margin-top:0">A student wants to chat with you</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${mentorName},</p>
    <p style="color:#6b7280;line-height:1.6"><strong>${studentName}</strong> just purchased a <strong>Text Q&amp;A</strong> session and wants to ask you their doubts over chat.</p>
    ${when || sessionDetails.amount ? `
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #6366f1">
      <h3 style="color:#6366f1;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Purchase Details</h3>
      ${when ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0 0 6px"><strong>When:</strong> ${when} (IST)</p>` : ''}
      ${sessionDetails.amount ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0 0 6px"><strong>Amount paid:</strong> ₹${sessionDetails.amount}</p>` : ''}
      ${sessionDetails.topic ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0"><strong>Topic:</strong> ${sessionDetails.topic}</p>` : ''}
    </div>
    ` : ''}
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #6366f1">
      <p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0">Open the conversation, answer their questions, and mark it resolved once you're done. You can reply on Atyant any time before the session day ends.</p>
    </div>
    <div style="text-align:center;margin:30px 0">
      <a href="${chatUrl}"
         style="background:#6366f1;color:#fff;padding:14px 36px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        💬 Open Chat
      </a>
    </div>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  const result = await sendEmail({
    to: mentorEmail,
    subject: `💬 ${studentName} wants to chat with you`,
    html
  });

  console.log("CHAT EMAIL RESULT =", result);
  console.log("mentorEmail =", mentorEmail);

  if (result.success) {
    console.log(`✅ Chat-request notification sent → ${mentorEmail}`);
  } else {
    console.error("❌ Chat email failed:", result.error);
  }

  return result;
};

export const sendTextQaPurchaseNotification = async ({
  studentEmail,
  studentName,
  mentorName,
  openChatUrl,
  sessionDetails = {},
}) => {
  const when = sessionDetails.scheduledAt
    ? new Date(sessionDetails.scheduledAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' })
    : null;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h1 style="color:#10b981;text-align:center;margin:0 0 30px">✨ Text Q&amp;A Purchased</h1>
  <div style="background:#f0fdf4;padding:30px;border-radius:10px;border-left:4px solid #10b981">
    <h2 style="color:#1f2937;margin-top:0">Your chat is ready</h2>
    <p style="color:#6b7280;line-height:1.6">Hi ${studentName},</p>
    <p style="color:#6b7280;line-height:1.6">Your <strong>Text Q&amp;A</strong> purchase with <strong>${mentorName}</strong> is confirmed. You can open the conversation and start asking your questions right away.</p>
    <div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:2px solid #10b981">
      <h3 style="color:#10b981;margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px">Purchase Details</h3>
      ${when ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0 0 6px"><strong>When:</strong> ${when} (IST)</p>` : ''}
      ${sessionDetails.amount ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0 0 6px"><strong>Amount paid:</strong> ₹${sessionDetails.amount}</p>` : ''}
      ${sessionDetails.topic ? `<p style="color:#1f2937;font-size:15px;line-height:1.6;margin:0"><strong>Topic:</strong> ${sessionDetails.topic}</p>` : ''}
    </div>
    <div style="text-align:center;margin:30px 0">
      <a href="${openChatUrl}"
         style="background:#10b981;color:#fff;padding:14px 36px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">
        Open Chat
      </a>
    </div>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:30px">© ${new Date().getFullYear()} Atyant. All rights reserved.</p>
</div>`;

  return sendEmail({
    to: studentEmail,
    subject: '✨ Your Text Q&A purchase is confirmed',
    html,
  });
};

