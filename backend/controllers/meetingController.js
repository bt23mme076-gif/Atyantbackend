import { google } from 'googleapis';
import User from '../models/User.js';
import meeting from '../models/meeting.js';
import { sendMentorBookingNotification, sendStudentBookingConfirmation } from '../utils/emailService.js';

export const scheduleMeeting = async (req, res) => {
  try {
    const { title, description, attendees, startTime, duration } = req.body;
    
    const user = await User.findById(req.user._id);
    
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Setup OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    );

    oauth2Client.setCredentials({
      access_token: user.accessToken,
      refresh_token: user.refreshToken
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const start = new Date(startTime);
    const end = new Date(start.getTime() + duration * 60000);

    const attendeesList = [
      { email: user.email },
      ...attendees.map(email => ({ email }))
    ];

    const event = {
      summary: title,
      description: description || `Meeting created by ${user.name}`,
      start: {
        dateTime: start.toISOString(),
        timeZone: 'Asia/Kolkata'
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'Asia/Kolkata'
      },
      attendees: attendeesList,
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 30 },
          { method: 'popup', minutes: 10 }
        ]
      }
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });

    // Save to database
    const meeting = await meeting.create({
      title,
      description,
      startTime: start,
      endTime: end,
      meetLink: response.data.hangoutLink,
      googleEventId: response.data.id,
      attendees: attendeesList,
      createdBy: user._id
    });

    res.status(201).json({
      success: true,
      meeting: {
        id: meeting._id,
        title: meeting.title,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        meetLink: meeting.meetLink,
        attendees: meeting.attendees
      }
    });

  } catch (error) {
    console.error('Schedule meeting error:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getMeetings = async (req, res) => {
  try {
    const meetings = await Meeting.find({
      createdBy: req.user._id,
      status: 'scheduled',
      startTime: { $gte: new Date() }
    })
    .sort({ startTime: 1 })
    .limit(50);

    res.json({ success: true, meetings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const cancelMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    
    const meeting = await Meeting.findOne({
      _id: id,
      createdBy: req.user._id
    });

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const user = await User.findById(req.user._id);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    );

    oauth2Client.setCredentials({
      access_token: user.accessToken,
      refresh_token: user.refreshToken
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: meeting.googleEventId,
      sendUpdates: 'all'
    });

    meeting.status = 'cancelled';
    await meeting.save();

    res.json({ success: true, message: 'Meeting cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const scheduleMeetingForBooking = async (bookingData) => {
  const { bookingId, mentorId, userId, scheduledAt, duration, title, description } = bookingData;

  const mentor = await User.findById(mentorId).select('+accessToken +refreshToken email name');
  
  if (!mentor || !mentor.accessToken) {
    throw new Error('Mentor not authenticated with Google Calendar');
  }

  const user = await User.findById(userId).select('email name');
  
  if (!user) {
    throw new Error('User not found');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: mentor.accessToken,
    refresh_token: mentor.refreshToken
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + duration * 60000);

  const attendeesList = [
    { email: mentor.email },
    { email: user.email }
  ];

  const event = {
    summary: title,
    description: `${description}\n\nBooking ID: ${bookingId}`,
    start: {
      dateTime: start.toISOString(),
      timeZone: 'Asia/Kolkata'
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: 'Asia/Kolkata'
    },
    attendees: attendeesList,
    conferenceData: {
      createRequest: {
        requestId: `booking-${bookingId}-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 1440 },
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 30 }
      ]
    }
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: 'all'
  });

  const Meeting = (await import('../models/Meeting.js')).default;

  const meeting = await Meeting.create({
    title,
    description,
    startTime: start,
    endTime: end,
    meetLink: response.data.hangoutLink,
    googleEventId: response.data.id,
    attendees: attendeesList,
    createdBy: mentorId,
    bookingId: bookingId
  });

  await sendMentorBookingNotification(mentor.email, bookingId, meeting.meetLink);
  await sendStudentBookingConfirmation(user.email, bookingId, meeting.meetLink);

  return {
    meetLink: response.data.hangoutLink,
    googleEventId: response.data.id,
    meetingId: meeting._id
  };
};