import { Resend } from 'resend';

// Initialize Resend only if API key is available
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!RESEND_API_KEY) {
  console.warn('⚠️ RESEND_API_KEY not found in environment variables. Email notifications will be disabled.');
} else {
  console.log('✅ Resend email service initialized successfully (emailService.js)');
}

// Send password reset email
export const sendPasswordResetEmail = async (email, resetToken) => {
  if (!resend) {
    console.warn('⚠️ Email service not configured. Skipping password reset email.');
    return { success: false, error: 'Email service not configured' };
  }
  
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>', // Use your verified domain when available
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
  if (!resend) {
    console.warn('⚠️ Email service not configured. Skipping password reset confirmation email.');
    return { success: false, error: 'Email service not configured' };
  }
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>',
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
  if (!resend) {
    console.warn('⚠️ Email service not configured. Skipping mentor payment notification email.');
    return { success: false, error: 'Email service not configured' };
  }
  
  try {
    const mentorshipTypeLabel = {
      'chat': '1-on-1 Chat Session',
      'video': 'Video Call Session',
      'roadmap': 'Complete Roadmap'
    };

    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>',
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
  if (!resend) {
    console.warn('⚠️ Email service not configured. Skipping mentor booking notification email.');
    return { success: false, error: 'Email service not configured' };
  }
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>',
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
  meetLink,
  manualSetup
}) => {
  if (!resend) {
    console.warn('⚠️ Email service not configured. Skipping student booking confirmation email.');
    return { success: false, error: 'Email service not configured' };
  }
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>',
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