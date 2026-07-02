// import { Resend } from 'resend';

// // Lazy-initialized so env is always read at call time, not module load time
// let _resend = null;
// function getResend() {
//   if (_resend) return _resend;
//   const key = process.env.RESEND_API_KEY;
//   if (!key) {
//     console.warn('⚠️ RESEND_API_KEY not set — emails disabled');
//     return null;
//   }
//   _resend = new Resend(key);
//   console.log('✅ Resend email service initialized');
//   return _resend;
// }

// // Shared footer for branded emails
// const emailFooter = `
//   <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//     <p>This email was sent by Atyant. If you have any questions, just reply to this email.</p>
//     <p>&copy; ${new Date().getFullYear()} Atyant. All rights reserved.</p>
//   </div>`;

// // ─────────────────────────────────────────────────────────────
// //  Welcome email — new STUDENT/USER signup
// // ─────────────────────────────────────────────────────────────
// export const sendUserWelcomeEmail = async (email, username) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping user welcome email.');
//     return { success: false, error: 'Email service not configured' };
//   }

//   const appUrl = process.env.FRONTEND_URL || 'https://atyant.in';
//   const name = username || 'there';

//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [email],
//       subject: 'Welcome to Atyant 🎉 — find someone exactly like you',
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>

//           <div style="background-color: #f8fafc; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
//             <h2 style="color: #1f2937; margin-top: 0;">Welcome aboard, ${name}! 🎉</h2>

//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 16px;">
//               You just joined Atyant — the place where you find seniors who walked <em>exactly</em> your path,
//               from your college and your branch, and learn how they cracked it.
//             </p>

//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">Here's what you can do right now:</p>
//             <ul style="color: #6b7280; line-height: 1.8; margin: 0 0 20px 18px; padding: 0;">
//               <li><strong>Ask any career question</strong> and get matched to seniors who've been there.</li>
//               <li><strong>Book a 1:1 session</strong> — chat or video — with a mentor from your background.</li>
//               <li><strong>Get a personalized roadmap</strong> for placements or internships.</li>
//             </ul>

//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${appUrl}"
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Find My Match
//               </a>
//             </div>

//             <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 24px;">
//               Have a question? Just reply to this email — a real person reads it.
//             </p>
//           </div>
//           ${emailFooter}
//         </div>
//       `
//     });

//     if (error) {
//       console.error('User welcome email error:', error);
//       throw new Error('Failed to send welcome email');
//     }
//     console.log('User welcome email sent:', data?.id);
//     return data;
//   } catch (error) {
//     console.error('Error sending user welcome email:', error);
//     throw error;
//   }
// };

// // ─────────────────────────────────────────────────────────────
// //  Welcome / invitation email — new MENTOR signup
// // ─────────────────────────────────────────────────────────────
// export const sendMentorWelcomeEmail = async (email, mentorName) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping mentor welcome email.');
//     return { success: false, error: 'Email service not configured' };
//   }

//   const appUrl = process.env.FRONTEND_URL || 'https://atyant.in';
//   const name = mentorName || 'there';

//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [email],
//       subject: 'Welcome to Atyant, mentor 🙌 — your journey can change a junior\'s life',
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>

//           <div style="background-color: #f0f5ff; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
//             <h2 style="color: #1f2937; margin-top: 0;">Welcome to the mentor community, ${name}! 🙌</h2>

//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 16px;">
//               Thank you for stepping up to guide juniors from a background like yours. The advice you wish
//               you'd had is exactly what a student on Atyant is searching for right now.
//             </p>

//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">Here's how Atyant works for you:</p>
//             <ul style="color: #6b7280; line-height: 1.8; margin: 0 0 20px 18px; padding: 0;">
//               <li><strong>Get discovered automatically</strong> — our AI matches you to students from your college, branch and goal.</li>
//               <li><strong>Guide on your terms</strong> — 1:1 chats and video sessions, scheduled around you.</li>
//               <li><strong>Build your reputation</strong> — a public mentor profile that showcases your journey and achievements.</li>
//               <li><strong>Earn for your time</strong> — set your own price per session, or mentor for free. Your call.</li>
//             </ul>

//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">
//               <strong>One quick step to go live:</strong> complete your mentor profile — add your companies,
//               expertise and your story — so students start matching with you.
//             </p>

//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${appUrl}"
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Complete My Mentor Profile
//               </a>
//             </div>

//             <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 24px;">
//               Questions about mentoring on Atyant? Just reply to this email.
//             </p>
//           </div>
//           ${emailFooter}
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Mentor welcome email error:', error);
//       throw new Error('Failed to send mentor welcome email');
//     }
//     console.log('Mentor welcome email sent:', data?.id);
//     return data;
//   } catch (error) {
//     console.error('Error sending mentor welcome email:', error);
//     throw error;
//   }
// };

// // ─────────────────────────────────────────────────────────────
// //  Session confirmed (after payment) — emails BOTH student & mentor
// //  with the auto-generated Google Meet link.
// // ─────────────────────────────────────────────────────────────
// export const sendSessionConfirmationEmails = async ({
//   studentEmail, studentName, mentorEmail, mentorName,
//   scheduledAt, durationMin, topic, meetLink, amount,
// }) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping session confirmation emails.');
//     return { success: false, error: 'Email service not configured' };
//   }

//   const when = new Date(scheduledAt).toLocaleString('en-IN', {
//     dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
//   });
//   const meetBlock = meetLink
//     ? `<div style="text-align:center;margin:28px 0;">
//          <a href="${meetLink}" style="background-color:#4F46E5;color:#fff;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Join Google Meet</a>
//          <p style="color:#9ca3af;font-size:12px;margin-top:10px;">Link: <a href="${meetLink}" style="color:#4F46E5;">${meetLink}</a></p>
//        </div>`
//     : `<p style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:8px;line-height:1.5;">
//          Your Google Meet link will be shared shortly before the session. We'll email it to you.
//        </p>`;

//   const card = (heading, intro) => `
//     <div style="font-family: Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
//       <div style="text-align:center; margin-bottom:30px;"><h1 style="color:#4F46E5; margin:0;">Atyant</h1></div>
//       <div style="background:#f0fdf4; padding:30px; border-radius:10px; border-left:4px solid #22c55e;">
//         <h2 style="color:#1f2937; margin-top:0;">${heading}</h2>
//         <p style="color:#6b7280; line-height:1.6;">${intro}</p>
//         <div style="background:#fff; padding:20px; border-radius:8px; margin:20px 0;">
//           <table style="width:100%; border-collapse:collapse;">
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Topic:</td><td style="padding:8px 0;color:#1f2937;">${topic || 'Mentorship Session'}</td></tr>
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">When:</td><td style="padding:8px 0;color:#1f2937;">${when} (IST)</td></tr>
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Duration:</td><td style="padding:8px 0;color:#1f2937;">${durationMin || 30} min</td></tr>
//             ${amount ? `<tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Amount paid:</td><td style="padding:8px 0;color:#22c55e;font-weight:700;">₹${amount}</td></tr>` : ''}
//           </table>
//         </div>
//         ${meetBlock}
//       </div>
//       ${emailFooter}
//     </div>`;

//   try {
//     const results = await Promise.allSettled([
//       getResend().emails.send({
//         from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//         to: [studentEmail],
//         subject: '✅ Your Atyant session is confirmed',
//         html: card('Your session is confirmed! 🎉',
//           `Hi ${studentName || 'there'}, your session with <strong>${mentorName || 'your mentor'}</strong> is booked. Add it to your calendar and join via the link below.`),
//       }),
//       getResend().emails.send({
//         from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//         to: [mentorEmail],
//         subject: `📅 New confirmed session with ${studentName || 'a student'}`,
//         html: card('You have a new confirmed session 🎉',
//           `Hi ${mentorName || 'there'}, <strong>${studentName || 'a student'}</strong> has booked and paid for a session with you. Join via the link below.`),
//       }),
//     ]);
//     results.forEach((r, i) => {
//       if (r.status === 'rejected') console.error(`Session email ${i === 0 ? 'student' : 'mentor'} failed:`, r.reason?.message);
//     });
//     return { success: true };
//   } catch (error) {
//     console.error('Error sending session confirmation emails:', error);
//     return { success: false, error: error.message };
//   }
// };

// // ─────────────────────────────────────────────────────────────
// //  Session reminder emails (24h / 1h before) — sent to BOTH the
// //  student and the mentor, with the Meet link so they can join.
// // ─────────────────────────────────────────────────────────────
// export const sendSessionReminderEmails = async ({
//   studentEmail, studentName, mentorEmail, mentorName,
//   scheduledAt, durationMin, topic, meetLink, label = '1 hour',
// }) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping session reminder emails.');
//     return { success: false, error: 'Email service not configured' };
//   }

//   const when = new Date(scheduledAt).toLocaleString('en-IN', {
//     dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
//   });
//   const meetBlock = meetLink
//     ? `<div style="text-align:center;margin:28px 0;">
//          <a href="${meetLink}" style="background-color:#4F46E5;color:#fff;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Join Google Meet</a>
//          <p style="color:#9ca3af;font-size:12px;margin-top:10px;">Link: <a href="${meetLink}" style="color:#4F46E5;">${meetLink}</a></p>
//        </div>`
//     : `<p style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:8px;line-height:1.5;">
//          The Google Meet link will be shared shortly before the session.
//        </p>`;

//   const card = (heading, intro) => `
//     <div style="font-family: Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
//       <div style="text-align:center; margin-bottom:30px;"><h1 style="color:#4F46E5; margin:0;">Atyant</h1></div>
//       <div style="background:#eff6ff; padding:30px; border-radius:10px; border-left:4px solid #4F46E5;">
//         <h2 style="color:#1f2937; margin-top:0;">${heading}</h2>
//         <p style="color:#6b7280; line-height:1.6;">${intro}</p>
//         <div style="background:#fff; padding:20px; border-radius:8px; margin:20px 0;">
//           <table style="width:100%; border-collapse:collapse;">
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Topic:</td><td style="padding:8px 0;color:#1f2937;">${topic || 'Mentorship Session'}</td></tr>
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">When:</td><td style="padding:8px 0;color:#1f2937;">${when} (IST)</td></tr>
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Starts in:</td><td style="padding:8px 0;color:#4F46E5;font-weight:700;">${label}</td></tr>
//             <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Duration:</td><td style="padding:8px 0;color:#1f2937;">${durationMin || 30} min</td></tr>
//           </table>
//         </div>
//         ${meetBlock}
//       </div>
//       ${emailFooter}
//     </div>`;

//   try {
//     const results = await Promise.allSettled([
//       getResend().emails.send({
//         from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//         to: [studentEmail],
//         subject: `⏰ Reminder: your Atyant session starts in ${label}`,
//         html: card(`Your session starts in ${label} ⏰`,
//           `Hi ${studentName || 'there'}, this is a reminder that your session with <strong>${mentorName || 'your mentor'}</strong> starts in ${label}. Join via the link below.`),
//       }),
//       getResend().emails.send({
//         from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//         to: [mentorEmail],
//         subject: `⏰ Reminder: your Atyant session with ${studentName || 'a student'} starts in ${label}`,
//         html: card(`Your session starts in ${label} ⏰`,
//           `Hi ${mentorName || 'there'}, this is a reminder that your session with <strong>${studentName || 'a student'}</strong> starts in ${label}. Join via the link below.`),
//       }),
//     ]);
//     results.forEach((r, i) => {
//       if (r.status === 'rejected') console.error(`Reminder email ${i === 0 ? 'student' : 'mentor'} failed:`, r.reason?.message);
//     });
//     return { success: true };
//   } catch (error) {
//     console.error('Error sending session reminder emails:', error);
//     return { success: false, error: error.message };
//   }
// };

// // Send password reset email
// export const sendPasswordResetEmail = async (email, resetToken) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping password reset email.');
//     return { success: false, error: 'Email service not configured' };
//   }
  
//   const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  
//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in', // Use your verified domain when available
//       to: [email],
//       subject: 'Password Reset Request - Atyant',
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>
          
//           <div style="background-color: #f8fafc; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
//             <h2 style="color: #1f2937; margin-top: 0;">Password Reset Request</h2>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               We received a request to reset the password for your Atyant account. If you didn't make this request, you can safely ignore this email.
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
//               To reset your password, click the button below. This link will expire in 1 hour for security reasons.
//             </p>
            
//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${resetUrl}" 
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Reset Password
//               </a>
//             </div>
            
//             <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 30px;">
//               If the button doesn't work, you can copy and paste this link into your browser:
//               <br>
//               <a href="${resetUrl}" style="color: #4F46E5; word-break: break-all;">${resetUrl}</a>
//             </p>
//           </div>
          
//           <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//             <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
//             <p>&copy; 2024 Atyant. All rights reserved.</p>
//           </div>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Email send error:', error);
//       throw new Error('Failed to send email');
//     }

//     console.log('Password reset email sent successfully:', data);
//     return data;
//   } catch (error) {
//     console.error('Error sending password reset email:', error);
//     throw error;
//   }
// };

// // Send password reset confirmation email
// export const sendPasswordResetConfirmation = async (email, username) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping password reset confirmation email.');
//     return { success: false, error: 'Email service not configured' };
//   }
  
//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [email],
//       subject: 'Password Reset Successful - Atyant',
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>
          
//           <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
//             <h2 style="color: #1f2937; margin-top: 0;">Password Reset Successful</h2>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Hi ${username},
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Your password has been successfully reset for your Atyant account. You can now log in using your new password.
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
//               If you didn't make this change, please contact our support team immediately.
//             </p>
            
//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${process.env.FRONTEND_URL}/login" 
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Login to Your Account
//               </a>
//             </div>
//           </div>
          
//           <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//             <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
//             <p>&copy; 2024 Atyant. All rights reserved.</p>
//           </div>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Email send error:', error);
//       throw new Error('Failed to send confirmation email');
//     }

//     console.log('Password reset confirmation email sent successfully:', data);
//     return data;
//   } catch (error) {
//     console.error('Error sending password reset confirmation email:', error);
//     throw error;
//   }
// };

// // Send payment notification to mentor
// export const sendMentorPaymentNotification = async (mentorEmail, mentorName, studentName, mentorshipType, amount, questionText) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping mentor payment notification email.');
//     return { success: false, error: 'Email service not configured' };
//   }
  
//   try {
//     const mentorshipTypeLabel = {
//       'chat': '1-on-1 Chat Session',
//       'video': 'Video Call Session',
//       'roadmap': 'Complete Roadmap'
//     };

//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [mentorEmail],
//       subject: `💰 New Payment Received - ${mentorshipTypeLabel[mentorshipType]}`,
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>
          
//           <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
//             <h2 style="color: #1f2937; margin-top: 0;">🎉 New Payment Received!</h2>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Hi ${mentorName},
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Great news! <strong>${studentName}</strong> has paid for a <strong>${mentorshipTypeLabel[mentorshipType]}</strong> with you.
//             </p>
            
//             <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
//               <table style="width: 100%; border-collapse: collapse;">
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${studentName}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${mentorshipTypeLabel[mentorshipType]}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
//                   <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${amount}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Question:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${questionText}</td>
//                 </tr>
//               </table>
//             </div>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
//               The student is waiting to connect with you. Please check your chat messages to start the session.
//             </p>
            
//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${process.env.FRONTEND_URL}/chat" 
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Open Chat
//               </a>
//             </div>
//           </div>
          
//           <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//             <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
//             <p>&copy; 2024 Atyant. All rights reserved.</p>
//           </div>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Email send error:', error);
//       throw new Error('Failed to send mentor notification email');
//     }

//     console.log('Mentor payment notification email sent successfully:', data);
//     return data;
//   } catch (error) {
//     console.error('Error sending mentor payment notification:', error);
//     throw error;
//   }
// };

// // Add mentor booking notification function
// export const sendMentorBookingNotification = async ({
//   mentorEmail,
//   mentorName,
//   userName,
//   userEmail,
//   scheduledAt,
//   duration,
//   bookingId,
//   bookingAmount
// }) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping mentor booking notification email.');
//     return { success: false, error: 'Email service not configured' };
//   }
  
//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [mentorEmail],
//       subject: `📅 New Booking Received - ${userName}`,
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>
          
//           <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
//             <h2 style="color: #1f2937; margin-top: 0;">🎉 New Booking Received!</h2>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Hi ${mentorName},
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Great news! <strong>${userName}</strong> has booked a <strong>${duration} ${duration === 1 ? 'session' : 'sessions'}</strong> with you.
//             </p>
            
//             <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
//               <table style="width: 100%; border-collapse: collapse;">
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${userName}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${duration} ${duration === 1 ? 'session' : 'sessions'}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
//                   <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${bookingAmount}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Scheduled:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${scheduledAt}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Booking ID:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${bookingId}</td>
//                 </tr>
//               </table>
//             </div>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
//               The student is waiting to connect with you. Please check your chat messages to start the session.
//             </p>
            
//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${process.env.FRONTEND_URL}/chat" 
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Open Chat
//               </a>
//             </div>
//           </div>
          
//           <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//             <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
//             <p>&copy; 2024 Atyant. All rights reserved.</p>
//           </div>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Email send error:', error);
//       throw new Error('Failed to send mentor booking notification email');
//     }

//     console.log('Mentor booking notification email sent successfully:', data);
//     return data;
//   } catch (error) {
//     console.error('Error sending mentor booking notification:', error);
//     throw error;
//   }
// };

// // Add student booking confirmation function
// export const sendStudentBookingConfirmation = async ({
//   userEmail,
//   userName,
//   mentorName,
//   scheduledAt,
//   duration,
//   bookingId,
//   bookingAmount,
//   meetLink,
//   manualSetup
// }) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured. Skipping student booking confirmation email.');
//     return { success: false, error: 'Email service not configured' };
//   }
  
//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [userEmail],
//       subject: 'Booking Confirmation - Atyant',
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
//           <div style="text-align: center; margin-bottom: 30px;">
//             <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
//           </div>
          
//           <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
//             <h2 style="color: #1f2937; margin-top: 0;">Booking Confirmation</h2>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Hi ${userName},
//             </p>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
//               Your booking for a <strong>${duration} ${duration === 1 ? 'session' : 'sessions'}</strong> with <strong>${mentorName}</strong> has been confirmed.
//             </p>
            
//             <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
//               <table style="width: 100%; border-collapse: collapse;">
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${userName}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${duration} ${duration === 1 ? 'session' : 'sessions'}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
//                   <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${bookingAmount}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Scheduled:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${scheduledAt}</td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Booking ID:</td>
//                   <td style="padding: 10px 0; color: #1f2937;">${bookingId}</td>
//                 </tr>
//               </table>
//             </div>
            
//             <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
//               The student is waiting to connect with you. Please check your chat messages to start the session.
//             </p>
            
//             <div style="text-align: center; margin: 30px 0;">
//               <a href="${meetLink}" 
//                  style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
//                 Join Meet
//               </a>
//             </div>
//           </div>
          
//           <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
//             <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
//             <p>&copy; 2024 Atyant. All rights reserved.</p>
//           </div>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Email send error:', error);
//       throw new Error('Failed to send student booking confirmation email');
//     }

//     console.log('Student booking confirmation email sent successfully:', data);
//     return data;
//   } catch (error) {
//     console.error('Error sending student booking confirmation:', error);
//     throw error;
//   }
// };
// // Send password reset OTP email
// export const sendPasswordOTPEmail = async (email, otp) => {
//   if (!getResend()) {
//     console.warn('⚠️ Email service not configured.');
//     return {
//       success: false,
//       error: 'Email service not configured'
//     };
//   }

//   try {
//     const { data, error } = await getResend().emails.send({
//       from: 'Atyant <notifications@atyant.in>',
//       replyTo: 'support@atyant.in',
//       to: [email],
//       subject: 'Your Atyant Password Reset Code',
      
//       // FIX #1: Clears the List-Unsubscribe header warning
//       headers: {
//         'List-Unsubscribe': '<mailto:support@atyant.in?subject=unsubscribe>'
//       },

//       // FIX #2: Expanded plain-text body to balance out the 45% text-to-HTML ratio penalty
//       text: `Atyant Password Reset\n\nWe received a request to reset your password for your Atyant account. Use the following verification code to complete your request:\n\n${otp}\n\nThis verification code expires in exactly 10 minutes. For security reasons, please do not share this code with anyone.\n\nIf you did not request this password change, you can safely ignore this email. Your account remains secure.\n\nRegards,\nTeam Atyant\nsupport@atyant.in`,
      
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; color: #333333; line-height: 1.6;">
//           <h1 style="color:#4F46E5; margin-bottom: 20px;">Atyant</h1>
//           <h2>Password Reset</h2>
//           <p>We received a request to reset your password.</p>
//           <p>Use the following verification code to complete your request:</p>
//           <div style="font-size:32px; font-weight:bold; color:#4F46E5; letter-spacing:6px; margin:30px 0; background-color: #f9fafb; padding: 15px; text-align: center; border-radius: 6px;">
//             ${otp}
//           </div>
//           <p>This code expires in <strong>10 minutes</strong>.</p>
//           <p style="color: #666666; font-size: 14px;">If you didn't request this password reset, you can safely ignore this email.</p>
//           <hr style="margin-top:30px; border:none; border-top:1px solid #eeeeee;">
//           <p style="font-size:12px; color:#999999; text-align: center;">
//             This email was sent by Atyant.<br>
//             If you have issues, contact support@atyant.in
//           </p>
//         </div>
//       `
//     });

//     if (error) {
//       console.error('Resend error:', error);
//       throw new Error('Failed to send OTP email');
//     }

//     return data;
//   } catch (error) {
//     console.error('OTP email error:', error);
//     throw error;
//   }
// };




import { Resend } from 'resend';

// Lazy-initialized so env is always read at call time, not module load time
let _resend = null;
function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('⚠️ RESEND_API_KEY not set — emails disabled');
    return null;
  }
  _resend = new Resend(key);
  console.log('✅ Resend email service initialized');
  return _resend;
}

// Shared footer for branded emails
const emailFooter = `
  <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by Atyant. If you have any questions, just reply to this email.</p>
    <p>&copy; ${new Date().getFullYear()} Atyant. All rights reserved.</p>
  </div>`;

// ─────────────────────────────────────────────────────────────
//  Welcome email — new STUDENT/USER signup
// ─────────────────────────────────────────────────────────────
export const sendUserWelcomeEmail = async (email, username) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping user welcome email.');
    return { success: false, error: 'Email service not configured' };
  }

  const appUrl = process.env.FRONTEND_URL || 'https://atyant.in';
  const name = username || 'there';

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [email],
      subject: 'Welcome to Atyant 🎉 — find someone exactly like you',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>

          <div style="background-color: #f8fafc; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
            <h2 style="color: #1f2937; margin-top: 0;">Welcome aboard, ${name}! 🎉</h2>

            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 16px;">
              You just joined Atyant — the place where you find seniors who walked <em>exactly</em> your path,
              from your college and your branch, and learn how they cracked it.
            </p>

            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">Here's what you can do right now:</p>
            <ul style="color: #6b7280; line-height: 1.8; margin: 0 0 20px 18px; padding: 0;">
              <li><strong>Ask any career question</strong> and get matched to seniors who've been there.</li>
              <li><strong>Book a 1:1 session</strong> — chat or video — with a mentor from your background.</li>
              <li><strong>Get a personalized roadmap</strong> for placements or internships.</li>
            </ul>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${appUrl}"
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Find My Match
              </a>
            </div>

            <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 24px;">
              Have a question? Just reply to this email — a real person reads it.
            </p>
          </div>
          ${emailFooter}
        </div>
      `
    });

    if (error) {
      console.error('User welcome email error:', error);
      throw new Error('Failed to send welcome email');
    }
    console.log('User welcome email sent:', data?.id);
    return data;
  } catch (error) {
    console.error('Error sending user welcome email:', error);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────
//  Welcome / invitation email — new MENTOR signup
// ─────────────────────────────────────────────────────────────
export const sendMentorWelcomeEmail = async (email, mentorName) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping mentor welcome email.');
    return { success: false, error: 'Email service not configured' };
  }

  const appUrl = process.env.FRONTEND_URL || 'https://atyant.in';
  const name = mentorName || 'there';

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [email],
      subject: 'Welcome to Atyant, mentor 🙌 — your journey can change a junior\'s life',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>

          <div style="background-color: #f0f5ff; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
            <h2 style="color: #1f2937; margin-top: 0;">Welcome to the mentor community, ${name}! 🙌</h2>

            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 16px;">
              Thank you for stepping up to guide juniors from a background like yours. The advice you wish
              you'd had is exactly what a student on Atyant is searching for right now.
            </p>

            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">Here's how Atyant works for you:</p>
            <ul style="color: #6b7280; line-height: 1.8; margin: 0 0 20px 18px; padding: 0;">
              <li><strong>Get discovered automatically</strong> — our AI matches you to students from your college, branch and goal.</li>
              <li><strong>Guide on your terms</strong> — 1:1 chats and video sessions, scheduled around you.</li>
              <li><strong>Build your reputation</strong> — a public mentor profile that showcases your journey and achievements.</li>
              <li><strong>Earn for your time</strong> — set your own price per session, or mentor for free. Your call.</li>
            </ul>

            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 8px;">
              <strong>One quick step to go live:</strong> complete your mentor profile — add your companies,
              expertise and your story — so students start matching with you.
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${appUrl}"
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Complete My Mentor Profile
              </a>
            </div>

            <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 24px;">
              Questions about mentoring on Atyant? Just reply to this email.
            </p>
          </div>
          ${emailFooter}
        </div>
      `
    });

    if (error) {
      console.error('Mentor welcome email error:', error);
      throw new Error('Failed to send mentor welcome email');
    }
    console.log('Mentor welcome email sent:', data?.id);
    return data;
  } catch (error) {
    console.error('Error sending mentor welcome email:', error);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────
//  Session confirmed (after payment) — emails BOTH student & mentor
//  with the auto-generated Google Meet link.
// ─────────────────────────────────────────────────────────────
export const sendSessionConfirmationEmails = async ({
  studentEmail, studentName, mentorEmail, mentorName,
  scheduledAt, durationMin, topic, meetLink, amount,
}) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping session confirmation emails.');
    return { success: false, error: 'Email service not configured' };
  }

  const when = new Date(scheduledAt).toLocaleString('en-IN', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  });
  const meetBlock = meetLink
    ? `<div style="text-align:center;margin:28px 0;">
         <a href="${meetLink}" style="background-color:#4F46E5;color:#fff;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Join Google Meet</a>
         <p style="color:#9ca3af;font-size:12px;margin-top:10px;">Link: <a href="${meetLink}" style="color:#4F46E5;">${meetLink}</a></p>
       </div>`
    : `<p style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:8px;line-height:1.5;">
         Your Google Meet link will be shared shortly before the session. We'll email it to you.
       </p>`;

  const card = (heading, intro) => `
    <div style="font-family: Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
      <div style="text-align:center; margin-bottom:30px;"><h1 style="color:#4F46E5; margin:0;">Atyant</h1></div>
      <div style="background:#f0fdf4; padding:30px; border-radius:10px; border-left:4px solid #22c55e;">
        <h2 style="color:#1f2937; margin-top:0;">${heading}</h2>
        <p style="color:#6b7280; line-height:1.6;">${intro}</p>
        <div style="background:#fff; padding:20px; border-radius:8px; margin:20px 0;">
          <table style="width:100%; border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Topic:</td><td style="padding:8px 0;color:#1f2937;">${topic || 'Mentorship Session'}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">When:</td><td style="padding:8px 0;color:#1f2937;">${when} (IST)</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Duration:</td><td style="padding:8px 0;color:#1f2937;">${durationMin || 30} min</td></tr>
            ${amount ? `<tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Amount paid:</td><td style="padding:8px 0;color:#22c55e;font-weight:700;">₹${amount}</td></tr>` : ''}
          </table>
        </div>
        ${meetBlock}
      </div>
      ${emailFooter}
    </div>`;

  try {
    const results = await Promise.allSettled([
      getResend().emails.send({
        from: 'Atyant <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [studentEmail],
        subject: '✅ Your Atyant session is confirmed',
        html: card('Your session is confirmed! 🎉',
          `Hi ${studentName || 'there'}, your session with <strong>${mentorName || 'your mentor'}</strong> is booked. Add it to your calendar and join via the link below.`),
      }),
      getResend().emails.send({
        from: 'Atyant <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [mentorEmail],
        subject: `📅 New confirmed session with ${studentName || 'a student'}`,
        html: card('You have a new confirmed session 🎉',
          `Hi ${mentorName || 'there'}, <strong>${studentName || 'a student'}</strong> has booked and paid for a session with you. Join via the link below.`),
      }),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Session email ${i === 0 ? 'student' : 'mentor'} failed:`, r.reason?.message);
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending session confirmation emails:', error);
    return { success: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────
//  Session reminder emails (24h / 1h before) — sent to BOTH the
//  student and the mentor, with the Meet link so they can join.
// ─────────────────────────────────────────────────────────────
export const sendSessionReminderEmails = async ({
  studentEmail, studentName, mentorEmail, mentorName,
  scheduledAt, durationMin, topic, meetLink, label = '1 hour',
}) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping session reminder emails.');
    return { success: false, error: 'Email service not configured' };
  }

  const when = new Date(scheduledAt).toLocaleString('en-IN', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  });
  const meetBlock = meetLink
    ? `<div style="text-align:center;margin:28px 0;">
         <a href="${meetLink}" style="background-color:#4F46E5;color:#fff;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Join Google Meet</a>
         <p style="color:#9ca3af;font-size:12px;margin-top:10px;">Link: <a href="${meetLink}" style="color:#4F46E5;">${meetLink}</a></p>
       </div>`
    : `<p style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:8px;line-height:1.5;">
         The Google Meet link will be shared shortly before the session.
       </p>`;

  const card = (heading, intro) => `
    <div style="font-family: Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
      <div style="text-align:center; margin-bottom:30px;"><h1 style="color:#4F46E5; margin:0;">Atyant</h1></div>
      <div style="background:#eff6ff; padding:30px; border-radius:10px; border-left:4px solid #4F46E5;">
        <h2 style="color:#1f2937; margin-top:0;">${heading}</h2>
        <p style="color:#6b7280; line-height:1.6;">${intro}</p>
        <div style="background:#fff; padding:20px; border-radius:8px; margin:20px 0;">
          <table style="width:100%; border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Topic:</td><td style="padding:8px 0;color:#1f2937;">${topic || 'Mentorship Session'}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">When:</td><td style="padding:8px 0;color:#1f2937;">${when} (IST)</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Starts in:</td><td style="padding:8px 0;color:#4F46E5;font-weight:700;">${label}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:600;">Duration:</td><td style="padding:8px 0;color:#1f2937;">${durationMin || 30} min</td></tr>
          </table>
        </div>
        ${meetBlock}
      </div>
      ${emailFooter}
    </div>`;

  try {
    const results = await Promise.allSettled([
      getResend().emails.send({
        from: 'Atyant <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [studentEmail],
        subject: `⏰ Reminder: your Atyant session starts in ${label}`,
        html: card(`Your session starts in ${label} ⏰`,
          `Hi ${studentName || 'there'}, this is a reminder that your session with <strong>${mentorName || 'your mentor'}</strong> starts in ${label}. Join via the link below.`),
      }),
      getResend().emails.send({
        from: 'Atyant <notifications@atyant.in>',
        replyTo: 'support@atyant.in',
        to: [mentorEmail],
        subject: `⏰ Reminder: your Atyant session with ${studentName || 'a student'} starts in ${label}`,
        html: card(`Your session starts in ${label} ⏰`,
          `Hi ${mentorName || 'there'}, this is a reminder that your session with <strong>${studentName || 'a student'}</strong> starts in ${label}. Join via the link below.`),
      }),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Reminder email ${i === 0 ? 'student' : 'mentor'} failed:`, r.reason?.message);
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending session reminder emails:', error);
    return { success: false, error: error.message };
  }
};

// Send password reset email
export const sendPasswordResetEmail = async (email, resetToken) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping password reset email.');
    return { success: false, error: 'Email service not configured' };
  }

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in', // Use your verified domain when available
      to: [email],
      subject: 'Password Reset Request - Atyant',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>
          
          <div style="background-color: #f8fafc; padding: 30px; border-radius: 10px; border-left: 4px solid #4F46E5;">
            <h2 style="color: #1f2937; margin-top: 0;">Password Reset Request</h2>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              We received a request to reset the password for your Atyant account. If you didn't make this request, you can safely ignore this email.
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
              To reset your password, click the button below. This link will expire in 1 hour for security reasons.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Reset Password
              </a>
            </div>
            
            <p style="color: #6b7280; line-height: 1.6; font-size: 14px; margin-top: 30px;">
              If the button doesn't work, you can copy and paste this link into your browser:
              <br>
              <a href="${resetUrl}" style="color: #4F46E5; word-break: break-all;">${resetUrl}</a>
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
            <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
            <p>&copy; 2024 Atyant. All rights reserved.</p>
          </div>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send email');
    }

    console.log('Password reset email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw error;
  }
};

// Send password reset confirmation email
export const sendPasswordResetConfirmation = async (email, username) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping password reset confirmation email.');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [email],
      subject: 'Password Reset Successful - Atyant',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>
          
          <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
            <h2 style="color: #1f2937; margin-top: 0;">Password Reset Successful</h2>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Hi ${username},
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Your password has been successfully reset for your Atyant account. You can now log in using your new password.
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
              If you didn't make this change, please contact our support team immediately.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/login" 
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Login to Your Account
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
            <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
            <p>&copy; 2024 Atyant. All rights reserved.</p>
          </div>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send confirmation email');
    }

    console.log('Password reset confirmation email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending password reset confirmation email:', error);
    throw error;
  }
};

// Send payment notification to mentor
export const sendMentorPaymentNotification = async (mentorEmail, mentorName, studentName, mentorshipType, amount, questionText) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping mentor payment notification email.');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const mentorshipTypeLabel = {
      'chat': '1-on-1 Chat Session',
      'video': 'Video Call Session',
      'roadmap': 'Complete Roadmap'
    };

    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [mentorEmail],
      subject: `💰 New Payment Received - ${mentorshipTypeLabel[mentorshipType]}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>
          
          <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
            <h2 style="color: #1f2937; margin-top: 0;">🎉 New Payment Received!</h2>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Hi ${mentorName},
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Great news! <strong>${studentName}</strong> has paid for a <strong>${mentorshipTypeLabel[mentorshipType]}</strong> with you.
            </p>
            
            <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${studentName}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${mentorshipTypeLabel[mentorshipType]}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
                  <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${amount}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Question:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${questionText}</td>
                </tr>
              </table>
            </div>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
              The student is waiting to connect with you. Please check your chat messages to start the session.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/chat" 
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Open Chat
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
            <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
            <p>&copy; 2024 Atyant. All rights reserved.</p>
          </div>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send mentor notification email');
    }

    console.log('Mentor payment notification email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending mentor payment notification:', error);
    throw error;
  }
};

// Add mentor booking notification function
export const sendMentorBookingNotification = async ({
  mentorEmail,
  mentorName,
  userName,
  userEmail,
  scheduledAt,
  duration,
  bookingId,
  bookingAmount
}) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping mentor booking notification email.');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [mentorEmail],
      subject: `📅 New Booking Received - ${userName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>
          
          <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
            <h2 style="color: #1f2937; margin-top: 0;">🎉 New Booking Received!</h2>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Hi ${mentorName},
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Great news! <strong>${userName}</strong> has booked a <strong>${duration} ${duration === 1 ? 'session' : 'sessions'}</strong> with you.
            </p>
            
            <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${userName}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${duration} ${duration === 1 ? 'session' : 'sessions'}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
                  <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${bookingAmount}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Scheduled:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${scheduledAt}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Booking ID:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${bookingId}</td>
                </tr>
              </table>
            </div>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
              The student is waiting to connect with you. Please check your chat messages to start the session.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/chat" 
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Open Chat
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
            <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
            <p>&copy; 2024 Atyant. All rights reserved.</p>
          </div>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send mentor booking notification email');
    }

    console.log('Mentor booking notification email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending mentor booking notification:', error);
    throw error;
  }
};

// Add student booking confirmation function
export const sendStudentBookingConfirmation = async ({
  userEmail,
  userName,
  mentorName,
  scheduledAt,
  duration,
  bookingId,
  bookingAmount,
  meetLink,
  manualSetup
}) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured. Skipping student booking confirmation email.');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [userEmail],
      subject: 'Booking Confirmation - Atyant',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4F46E5; margin: 0;">Atyant</h1>
          </div>
          
          <div style="background-color: #f0fdf4; padding: 30px; border-radius: 10px; border-left: 4px solid #22c55e;">
            <h2 style="color: #1f2937; margin-top: 0;">Booking Confirmation</h2>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Hi ${userName},
            </p>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 20px;">
              Your booking for a <strong>${duration} ${duration === 1 ? 'session' : 'sessions'}</strong> with <strong>${mentorName}</strong> has been confirmed.
            </p>
            
            <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Student:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${userName}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Service:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${duration} ${duration === 1 ? 'session' : 'sessions'}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Amount:</td>
                  <td style="padding: 10px 0; color: #22c55e; font-weight: 700; font-size: 18px;">₹${bookingAmount}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600; vertical-align: top;">Scheduled:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${scheduledAt}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-weight: 600;">Booking ID:</td>
                  <td style="padding: 10px 0; color: #1f2937;">${bookingId}</td>
                </tr>
              </table>
            </div>
            
            <p style="color: #6b7280; line-height: 1.6; margin-bottom: 30px;">
              The student is waiting to connect with you. Please check your chat messages to start the session.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${meetLink}" 
                 style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                Join Meet
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
            <p>This email was sent by Atyant. If you have any questions, please contact our support team.</p>
            <p>&copy; 2024 Atyant. All rights reserved.</p>
          </div>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send student booking confirmation email');
    }

    console.log('Student booking confirmation email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending student booking confirmation:', error);
    throw error;
  }
};
// Send password reset OTP email
export const sendSignupOTPEmail = async (email, otp) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured.');
    return {
      success: false,
      error: 'Email service not configured'
    };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [email],
      subject: 'Verify Your Atyant Account',

      headers: {
        'List-Unsubscribe': '<mailto:support@atyant.in?subject=unsubscribe>'
      },

      text: `Welcome to Atyant\n\nUse the following verification code to complete your signup:\n\n${otp}\n\nThis verification code expires in exactly 10 minutes. For security reasons, please do not share this code with anyone.\n\nIf you did not request this, you can safely ignore this email.\n\nRegards,\nTeam Atyant\nsupport@atyant.in`,

      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; color: #333333; line-height: 1.6;">
          <h1 style="color:#4F46E5; margin-bottom: 20px;">Atyant</h1>
          <h2>Verify Your Account</h2>
          <p>Use the following verification code to complete your signup:</p>
          <div style="font-size:32px; font-weight:bold; color:#4F46E5; letter-spacing:6px; margin:30px 0; background-color: #f9fafb; padding: 15px; text-align: center; border-radius: 6px;">
            ${otp}
          </div>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p style="color: #666666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
          <hr style="margin-top:30px; border:none; border-top:1px solid #eeeeee;">
          <p style="font-size:12px; color:#999999; text-align: center;">
            This email was sent by Atyant.<br>
            If you have issues, contact support@atyant.in
          </p>
        </div>
      `
    });

    if (error) {
      console.error('Resend error:', error);
      throw new Error('Failed to send OTP email');
    }

    return data;
  } catch (error) {
    console.error('Signup OTP email error:', error);
    throw error;
  }
};

export const sendPasswordOTPEmail = async (email, otp) => {
  if (!getResend()) {
    console.warn('⚠️ Email service not configured.');
    return {
      success: false,
      error: 'Email service not configured'
    };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: 'Atyant <notifications@atyant.in>',
      replyTo: 'support@atyant.in',
      to: [email],
      subject: 'Your Atyant Password Reset Code',

      // FIX #1: Clears the List-Unsubscribe header warning
      headers: {
        'List-Unsubscribe': '<mailto:support@atyant.in?subject=unsubscribe>'
      },

      // FIX #2: Expanded plain-text body to balance out the 45% text-to-HTML ratio penalty
      text: `Atyant Password Reset\n\nWe received a request to reset your password for your Atyant account. Use the following verification code to complete your request:\n\n${otp}\n\nThis verification code expires in exactly 10 minutes. For security reasons, please do not share this code with anyone.\n\nIf you did not request this password change, you can safely ignore this email. Your account remains secure.\n\nRegards,\nTeam Atyant\nsupport@atyant.in`,

      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; color: #333333; line-height: 1.6;">
          <h1 style="color:#4F46E5; margin-bottom: 20px;">Atyant</h1>
          <h2>Password Reset</h2>
          <p>We received a request to reset your password.</p>
          <p>Use the following verification code to complete your request:</p>
          <div style="font-size:32px; font-weight:bold; color:#4F46E5; letter-spacing:6px; margin:30px 0; background-color: #f9fafb; padding: 15px; text-align: center; border-radius: 6px;">
            ${otp}
          </div>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p style="color: #666666; font-size: 14px;">If you didn't request this password reset, you can safely ignore this email.</p>
          <hr style="margin-top:30px; border:none; border-top:1px solid #eeeeee;">
          <p style="font-size:12px; color:#999999; text-align: center;">
            This email was sent by Atyant.<br>
            If you have issues, contact support@atyant.in
          </p>
        </div>
      `
    });

    if (error) {
      console.error('Resend error:', error);
      throw new Error('Failed to send OTP email');
    }

    return data;
  } catch (error) {
    console.error('OTP email error:', error);
    throw error;
  }
};