import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Service from '../models/Service.js';

class BookingService {
  constructor() {
    // Initialize Google Calendar
    this.calendar = null;
    if (process.env.GOOGLE_CALENDAR_ENABLED === 'true') {
      const credentials = {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      };
      
      if (credentials.client_email && credentials.private_key) {
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/calendar']
        });
        this.calendar = google.calendar({ version: 'v3', auth });
      } else {
        console.warn('⚠️ Google Calendar credentials missing or incomplete');
      }
    }

    // Initialize email transporter
    // Handle both ESM and CommonJS nodemailer exports
    const createTransport = nodemailer.createTransport || nodemailer.default?.createTransport;
    if (!createTransport) {
      console.warn('⚠️ Nodemailer not available, emails will not be sent');
      this.emailTransporter = null;
    } else {
      this.emailTransporter = createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
  }

  // Generate Google Meet link
  async generateMeetingLink(booking, mentor, user) {
    try {
      // 1. Try using Mentor's Google OAuth first (preferred)
      if (mentor.accessToken && mentor.refreshToken) {
        try {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CALENDAR_CLIENT_ID,
            process.env.GOOGLE_CALENDAR_CLIENT_SECRET
          );

          oauth2Client.setCredentials({
            access_token: mentor.accessToken,
            refresh_token: mentor.refreshToken
          });

          const mentorCalendar = google.calendar({ version: 'v3', auth: oauth2Client });
          
          const event = {
            summary: `${booking.serviceType === 'video-call' ? 'Video' : 'Audio'} Call: ${user.name || user.username} & ${mentor.name || mentor.username}`,
            description: `Atyant Mentorship Session\nBooking ID: ${booking._id}\nNotes: ${booking.notes || 'None'}`,
            start: {
              dateTime: booking.scheduledAt.toISOString(),
              timeZone: 'Asia/Kolkata'
            },
            end: {
              dateTime: new Date(booking.scheduledAt.getTime() + (booking.duration || 30) * 60000).toISOString(),
              timeZone: 'Asia/Kolkata'
            },
            attendees: [
              { email: user.email },
              { email: mentor.email }
            ],
            conferenceData: {
              createRequest: {
                requestId: `atyant-${booking._id}-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' }
              }
            }
          };

          const response = await mentorCalendar.events.insert({
            calendarId: 'primary',
            resource: event,
            conferenceDataVersion: 1,
            sendUpdates: 'all'
          });

          booking.googleCalendarEventId = response.data.id;
          booking.meetingLink = response.data.hangoutLink;
          await booking.save();
          
          console.log(`✅ Meeting created via Mentor OAuth: ${response.data.hangoutLink}`);
          return response.data.hangoutLink;
        } catch (oauthError) {
          console.error('Mentor OAuth meeting generation failed, falling back to Service Account:', oauthError.message);
        }
      }

      // 2. Fallback to Service Account if Mentor OAuth fails or is missing
      if (this.calendar) {
        const event = {
          summary: `${booking.serviceType === 'video-call' ? 'Video' : 'Audio'} Call: ${user.name || user.username} & ${mentor.name || mentor.username}`,
          description: `Atyant Mentorship Session\nBooking ID: ${booking._id}\nNotes: ${booking.notes || 'None'}`,
          start: {
            dateTime: booking.scheduledAt.toISOString(),
            timeZone: 'Asia/Kolkata'
          },
          end: {
            dateTime: new Date(booking.scheduledAt.getTime() + (booking.duration || 30) * 60000).toISOString(),
            timeZone: 'Asia/Kolkata'
          },
          attendees: [
            { email: user.email },
            { email: mentor.email }
          ],
          conferenceData: {
            createRequest: {
              requestId: booking._id.toString(),
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          }
        };

        const response = await this.calendar.events.insert({
          calendarId: 'primary',
          resource: event,
          conferenceDataVersion: 1,
          sendUpdates: 'all'
        });

        booking.googleCalendarEventId = response.data.id;
        booking.meetingLink = response.data.hangoutLink;
        await booking.save();

        console.log(`✅ Meeting created via Service Account: ${response.data.hangoutLink}`);
        return response.data.hangoutLink;
      }

      // 3. Last Fallback: Generic Link
      const fallbackLink = `https://meet.atyant.in/${booking._id}`;
      booking.meetingLink = fallbackLink;
      await booking.save();
      return fallbackLink;

    } catch (error) {
      console.error('Generate meeting link total failure:', error);
      const finalFallback = `https://meet.atyant.in/${booking._id}`;
      booking.meetingLink = finalFallback;
      await booking.save();
      return finalFallback;
    }
  }

  // Send booking confirmation email
  async sendConfirmationEmail(booking, mentor, user, service) {
    try {
      // Get proper names with fallbacks
      const userName = user.name || user.username || 'User';
      const mentorName = mentor.name || mentor.username || 'Mentor';
      
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .booking-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
            .detail-row:last-child { border-bottom: none; }
            .button { display: inline-block; padding: 12px 30px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
            .footer { text-align: center; color: #718096; font-size: 12px; margin-top: 30px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ Booking Confirmed!</h1>
              <p>Your session has been successfully booked</p>
            </div>
            <div class="content">
              <h2>Hi ${userName},</h2>
              <p>Your booking with <strong>${mentorName}</strong> has been confirmed!</p>
              
              <div class="booking-details">
                <h3>Booking Details</h3>
                <div class="detail-row">
                  <span>Service:</span>
                  <strong>${service.title}</strong>
                </div>
                <div class="detail-row">
                  <span>Date & Time:</span>
                  <strong>${booking.scheduledAt ? new Date(booking.scheduledAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' }) : 'N/A'}</strong>
                </div>
                <div class="detail-row">
                  <span>Duration:</span>
                  <strong>${service.duration || 30} minutes</strong>
                </div>
                <div class="detail-row">
                  <span>Amount Paid:</span>
                  <strong>₹${booking.amount}</strong>
                </div>
                <div class="detail-row">
                  <span>Booking ID:</span>
                  <strong>${booking._id}</strong>
                </div>
              </div>

              ${booking.meetingLink ? `
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${booking.meetingLink}" class="button">Join Meeting</a>
                  <p style="font-size: 14px; color: #718096;">Click the button above to join your session</p>
                </div>
              ` : ''}

              <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <strong>📝 Your Notes:</strong>
                <p>${booking.notes || 'No notes provided'}</p>
              </div>

              <h3>What's Next?</h3>
              <ul>
                <li>You'll receive a reminder 24 hours before your session</li>
                <li>Another reminder will be sent 1 hour before</li>
                <li>Make sure to join on time using the meeting link</li>
                <li>You can reschedule or cancel from your dashboard</li>
              </ul>

              <div class="footer">
                <p>© 2026 Atyant. All rights reserved.</p>
                <p>Need help? Contact us at support@atyant.in</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      if (this.emailTransporter) {
        await this.emailTransporter.sendMail({
          from: `"Atyant" <${process.env.SMTP_USER}>`,
          to: user.email,
          subject: `✅ Booking Confirmed - ${service.title}`,
          html: emailHtml
        });

        // Send to mentor too
        const mentorEmailHtml = emailHtml.replace(`Hi ${userName}`, `Hi ${mentorName}`).replace('Your booking with', `New booking from ${userName} for`);
        
        await this.emailTransporter.sendMail({
          from: `"Atyant" <${process.env.SMTP_USER}>`,
          to: mentor.email,
          subject: `🔔 New Booking - ${service.title}`,
          html: mentorEmailHtml
        });

        console.log('✅ Confirmation emails sent');
      } else {
        console.warn('⚠️ Email transporter not available, skipping confirmation emails');
      }
    } catch (error) {
      console.error('Send confirmation email error:', error);
    }
  }

  // Create booking
  async createBooking({ userId, mentorId, serviceId, scheduledAt, notes, amount, razorpayPaymentId, razorpayOrderId }) {
    try {
      // Fetch service details
      const service = await Service.findById(serviceId);
      if (!service) {
        throw new Error('Service not found');
      }

      // Fetch mentor and user details
      const [mentor, user] = await Promise.all([
        User.findById(mentorId).select('+accessToken +refreshToken email name username'),
        User.findById(userId)
      ]);

      if (!mentor || !user) {
        throw new Error('Mentor or user not found');
      }

      // Create booking
      const booking = new Booking({
        serviceId,
        mentorId,
        userId,
        razorpayPaymentId,
        razorpayOrderId,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        serviceType: service.type,
        status: 'confirmed',
        amount,
        notes: notes || '',
        rescheduleCount: 0
      });

      await booking.save();

      // Generate meeting link for video/audio calls
      if (service.type === 'video-call' || service.type === 'audio-call') {
        if (scheduledAt) {
          await this.generateMeetingLink(booking, mentor, user);
        }
      }

      // Send confirmation emails
      await this.sendConfirmationEmail(booking, mentor, user, service);

      // Update service stats
      await Service.findByIdAndUpdate(serviceId, {
        $inc: { totalSales: 1, totalRevenue: amount }
      });

      console.log(`✅ Booking created: ${booking._id} | ${service.type} | ₹${amount}`);

      return booking;
    } catch (error) {
      console.error('Create booking error:', error);
      throw error;
    }
  }

  // Send reminder emails
  async sendReminder(booking, type) {
    try {
      const [mentor, user, service] = await Promise.all([
        User.findById(booking.mentorId),
        User.findById(booking.userId),
        Service.findById(booking.serviceId)
      ]);

      // Get proper names with fallbacks
      const userName = user.name || user.username || 'User';
      const mentorName = mentor.name || mentor.username || 'Mentor';
      
      const timeUntil = type === '24h' ? '24 hours' : '1 hour';
      
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 12px 30px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>⏰ Reminder: Upcoming Session</h1>
              <p>Your session starts in ${timeUntil}</p>
            </div>
            <div class="content">
              <h2>Hi ${userName},</h2>
              <p>This is a reminder that your session with <strong>${mentorName}</strong> is coming up!</p>
              
              <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Service:</strong> ${service.title}</p>
                <p><strong>Time:</strong> ${new Date(booking.scheduledAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' })}</p>
                <p><strong>Duration:</strong> ${service.duration} minutes</p>
              </div>

              ${booking.meetingLink ? `
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${booking.meetingLink}" class="button">Join Meeting</a>
                </div>
              ` : ''}

              <p>See you soon!</p>
            </div>
          </div>
        </body>
        </html>
      `;

      if (this.emailTransporter) {
        await this.emailTransporter.sendMail({
          from: `"Atyant" <${process.env.SMTP_USER}>`,
          to: user.email,
          subject: `⏰ Reminder: Session in ${timeUntil}`,
          html: emailHtml
        });
      } else {
        console.warn('⚠️ Email transporter not available, skipping reminder email');
      }

      // Update reminder status
      if (type === '24h') {
        booking.remindersSent.email24h = true;
      } else {
        booking.remindersSent.email1h = true;
      }
      await booking.save();

      console.log(`✅ ${type} reminder sent for booking ${booking._id}`);
    } catch (error) {
      console.error('Send reminder error:', error);
    }
  }

  // Reschedule booking
  async rescheduleBooking(bookingId, newDate, newTime, userId) {
    try {
      const booking = await Booking.findById(bookingId);
      
      if (!booking) {
        throw new Error('Booking not found');
      }

      if (booking.userId.toString() !== userId) {
        throw new Error('Unauthorized');
      }

      if (booking.rescheduleCount >= 2) {
        throw new Error('Maximum reschedule limit reached (2 times)');
      }

      // Create new booking
      const newScheduledAt = new Date(`${newDate}T${newTime}`);
      const newBooking = new Booking({
        ...booking.toObject(),
        _id: undefined,
        scheduledAt: newScheduledAt,
        rescheduledFrom: booking._id,
        rescheduleCount: booking.rescheduleCount + 1,
        status: 'confirmed',
        googleCalendarEventId: null,
        meetingLink: null
      });

      await newBooking.save();

      // Update old booking
      booking.status = 'cancelled';
      booking.rescheduledTo = newBooking._id;
      booking.cancelledAt = new Date();
      booking.cancellationReason = 'Rescheduled';
      await booking.save();

      // Generate new meeting link
      const [mentor, user] = await Promise.all([
        User.findById(booking.mentorId),
        User.findById(booking.userId)
      ]);

      await this.generateMeetingLink(newBooking, mentor, user);

      return newBooking;
    } catch (error) {
      console.error('Reschedule booking error:', error);
      throw error;
    }
  }

  // Cancel booking with refund
  async cancelBooking(bookingId, userId, reason, cancelledBy = 'user') {
    try {
      const booking = await Booking.findById(bookingId);
      
      if (!booking) {
        throw new Error('Booking not found');
      }

      if (cancelledBy === 'user' && booking.userId.toString() !== userId) {
        throw new Error('Unauthorized');
      }

      // Calculate refund based on cancellation time
      const hoursUntilSession = (new Date(booking.scheduledAt) - new Date()) / (1000 * 60 * 60);
      let refundPercentage = 0;

      if (hoursUntilSession > 24) {
        refundPercentage = 100; // Full refund
      } else if (hoursUntilSession > 12) {
        refundPercentage = 50; // 50% refund
      } else {
        refundPercentage = 0; // No refund
      }

      const refundAmount = (booking.amount * refundPercentage) / 100;

      booking.status = 'cancelled';
      booking.cancelledAt = new Date();
      booking.cancellationReason = reason;
      booking.cancelledBy = cancelledBy;
      booking.refundAmount = refundAmount;
      booking.refundStatus = refundAmount > 0 ? 'pending' : 'none';

      await booking.save();

      // TODO: Process refund via Razorpay
      // if (refundAmount > 0) {
      //   await processRazorpayRefund(booking.paymentId, refundAmount);
      // }

      return { booking, refundAmount, refundPercentage };
    } catch (error) {
      console.error('Cancel booking error:', error);
      throw error;
    }
  }
}

export default new BookingService();
