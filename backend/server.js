import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import { Resend } from 'resend';
import path from 'path';
import passport from 'passport';
import errorHandler from './middleware/errorHandler.js';

// ─── Routes ────────────────────────────────────────────────────────────────
import authRoutes        from './routes/auth.js';
import profileRoutes     from './routes/profileRoutes.js';
import clarityRoutes     from './routes/clarityRoutes.js';
import sessionRoutes     from './routes/sessionRoutes.js';
import savedAnswerRoutes from './routes/savedAnswerRoutes.js';
import roadmapRoutes     from './routes/roadmapRoutes.js';
import aiRoutes          from './routes/aiRoutes.js';

// ─── Models / utils ────────────────────────────────────────────────────────
import Message      from './models/Message.js';
import User         from './models/User.js';
import { moderator } from './utils/ContentModerator.js';
import { globalRateLimit } from './middleware/globalRateLimiter.js';
import { sendAutoReply }   from './controllers/messageController.js';
import ReminderCron from './services/ReminderCron.js';

// ─── Passport Configuration ────────────────────────────────────────────────
import './config/passport.js';

// ─────────────────────────────────────────────
//  APP SETUP
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);


// Static uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Gzip
app.use(compression({
  filter   : (req, res) => req.headers['x-no-compression'] ? false : compression.filter(req, res),
  level    : 6,
  threshold: 1024
}));

// ─── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = Array.from(new Set([
  'https://atyant.in',
  'https://www.atyant.in',
  'http://localhost:5173',
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_WWW,
  process.env.DEV_URL
].filter(Boolean)));

console.log('🔒 CORS Allowed Origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all localhost ports for development
    if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
      return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Removed console.warn to avoid excessive logging
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight for 10 minutes
}));

// Handle preflight requests explicitly
app.options('*', cors());

// Build a strict Content Security Policy (CSP)
let dynamicOrigins = [];
try {
  dynamicOrigins = allowedOrigins.map(o => {
    try { return new URL(o).origin; } catch { return o; }
  });
} catch (e) {
  dynamicOrigins = [];
}

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
  connectSrc: ["'self'", 'wss:', 'https:', ...dynamicOrigins],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
  objectSrc: ["'none'"],
};

app.use(helmet({
  contentSecurityPolicy: {
    directives: cspDirectives
  }
}));

// Parse cookies so we can read HttpOnly tokens
app.use(cookieParser());

app.use(express.json({ limit: '10mb' }));

// Cache-control headers
app.use((req, res, next) => {
  if      (req.path.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
  else if (req.path.match(/\.(css|js)$/))                    res.set('Cache-Control', 'public, max-age=604800');
  else if (req.path.startsWith('/api/'))                     res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ─────────────────────────────────────────────
//  DATABASE
//  🔴 FIX: No hardcoded URI — must come from .env
// ─────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set in environment variables. Server will not start.');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  maxPoolSize            : 10,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS        : 45000,
  connectTimeoutMS       : 30000,
})
  .then(() => {
    console.log('✅ MongoDB connected');
    // Start reminder cron job
    ReminderCron.start();
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

if (process.env.NODE_ENV === 'production') mongoose.set('debug', false);

// ─── Rate limiter ──────────────────────────────────────────────────────────
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/community-chat')) return next();
  globalRateLimit(req, res, next);
});

// ─── Session & Passport (for Google OAuth) ─────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    touchAfter: 24 * 3600
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' // Important for cross-domain
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/auth',              authRoutes);      // Google OAuth callback
app.use('/api/profile',       profileRoutes);
app.use('/api/clarity',       clarityRoutes);
app.use('/api/sessions',      sessionRoutes);
app.use('/api/saved-answers', savedAnswerRoutes);
app.use('/api/roadmap',       roadmapRoutes);
app.use('/api/ai',            aiRoutes);

// ─── Book a session (from BookingPage) ─────────────────────────────────────
app.post('/api/book-session', async (req, res) => {
  try {
    const { mentor, sessionType, date, time, amount, goals, brief, name, email, coupon } = req.body;
    if (!date || !time || !name || !email) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    // Store booking in Session collection reusing the existing model
    const { default: Session } = await import('./models/Session.js');
    const scheduledAt = new Date(`${date} ${time}`);
    await Session.create({
      name, email, mentor, sessionType, scheduledAt,
      amount, goals: goals || [], brief: brief || '',
      coupon: coupon || null, status: 'pending',
    });
    res.json({ ok: true, message: 'Session booked successfully' });
  } catch (err) {
    console.error('book-session error:', err.message);
    res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});

// Centralized error handler (should be last app.use before server start)
app.use(errorHandler);

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status     : 'OK',
    timestamp  : new Date().toISOString(),
    uptime     : process.uptime(),
    memory     : process.memoryUsage(),
    connections: io?.engine?.clientsCount || 0
  });
});

// ─── Profile by username ───────────────────────────────────────────────────
app.get('/api/profile/:username', async (req, res) => {
  try {
    const profile = await User.findOne({ username: req.params.username })
      .select('-password -passwordResetToken -passwordResetExpires -verificationToken')
      .lean();
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    res.json(profile);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching profile' });
  }
});

// ─── Validate mentor ───────────────────────────────────────────────────────
app.post('/api/validate-mentor', async (req, res) => {
  try {
    const { mentorId } = req.body;
    const mentor = await User.findById(mentorId).select('role username chatDisabled').lean();
    if (!mentor)                 return res.status(404).json({ valid: false, message: 'Mentor not found' });
    if (mentor.role !== 'mentor') return res.status(400).json({ valid: false, message: 'Not a mentor' });
    if (mentor.chatDisabled)      return res.status(403).json({ valid: false, message: 'Mentor not accepting messages' });
    res.json({ valid: true, mentor });
  } catch (error) {
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// ─── Contact form ──────────────────────────────────────────────────────────
// 🔴 FIX: Contact model was used but never imported — using simple email via Resend instead
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ message: 'All fields required' });
    }
    if (resend) {
      await resend.emails.send({
        from   : 'Atyant <notification@atyant.in>',
        to     : ['support@atyant.in'],
        subject: `Contact: ${name}`,
        text   : `From: ${name} <${email}>\n\n${message}`
      });
    }
    res.json({ message: 'Message received. We\'ll get back to you soon!' });
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Debug endpoints (dev only) ────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug/connections', (req, res) => {
    const rooms      = io.sockets.adapter.rooms;
    const activeRooms = {};
    rooms.forEach((sockets, roomName) => {
      if (roomName.length === 24) {
        activeRooms[roomName] = { socketCount: sockets.size };
      }
    });
    res.json({ activeConnections: io.engine.clientsCount, activeRooms });
  });

  app.get('/api/debug/messages', async (req, res) => {
    try {
      const messages = await Message.find()
        .populate('sender receiver', 'username name')
        .sort({ createdAt: -1 }).limit(10).lean();
      res.json({ count: messages.length, messages });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/debug/routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods)
      });
    } else if (middleware.name === 'router') {
      middleware.handle.stack.forEach(handler => {
        if (handler.route) {
          routes.push({
            path: handler.route.path,
            methods: Object.keys(handler.route.methods)
          });
        }
      });
    }
  });
  res.json(routes);
});
}

// ─────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true },
  transports      : ['websocket', 'polling'],
  pingTimeout     : 60000,
  pingInterval    : 25000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: { threshold: 1024 }
});

// Authenticate socket connections using JWT from handshake
io.use((socket, next) => {
  try {
    // Try JWT from socket auth, Authorization header, or cookie
    let authToken = socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization && socket.handshake.headers.authorization.split(' ')[1]);

    // If still no token, try to parse cookie header (token cookie)
    if (!authToken && socket.handshake.headers?.cookie) {
      const cookieHeader = socket.handshake.headers.cookie;
      const match = cookieHeader.match(/(?:^|; )token=([^;]+)/);
      if (match) authToken = decodeURIComponent(match[1]);
    }

    if (!authToken) return next(new Error('Authentication error'));
    const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
    socket.user = {
      ...decoded,
      userId: decoded.userId || decoded.id || decoded._id
    };
    return next();
  } catch (err) {
    return next(new Error('Authentication error'));
  }
});

// In-memory maps (per process)
const activeUsers          = new Map();
const userSockets          = new Map();
const pendingNotifications = new Map();

io.on('connection', socket => {
  let currentUserId = null;

  socket.on('join_user_room', userId => {
    // Ignore client-supplied userId and use verified JWT identity
    const socketUserId = socket.user?.userId;
    if (!socketUserId) return socket.emit('auth_error', { error: 'Not authenticated' });
    currentUserId = socketUserId;
    socket.join(currentUserId);
    userSockets.set(currentUserId, socket.id);
    if (!activeUsers.has(currentUserId)) activeUsers.set(currentUserId, new Set());
  });

  socket.on('enter_chat', ({ partnerId }) => {
    if (!currentUserId) return;
    const userChats = activeUsers.get(currentUserId) || new Set();
    userChats.add(partnerId);
    activeUsers.set(currentUserId, userChats);
    pendingNotifications.delete(`${partnerId}-${currentUserId}`);
    pendingNotifications.delete(`email-${partnerId}-${currentUserId}`);
  });

  socket.on('leave_chat', ({ partnerId }) => {
    if (!currentUserId) return;
    activeUsers.get(currentUserId)?.delete(partnerId);
  });

  socket.on('disconnect', () => {
    if (!currentUserId) return;
    userSockets.delete(currentUserId);
    activeUsers.delete(currentUserId);
  });

  socket.on('private_message', async data => {
    try {
      if (!data?.text) {
        return socket.emit('message_error', { error: 'Message cannot be empty' });
      }

      const validationResult = moderator.validateMessage(data.text);
      if (!validationResult.isValid) {
        return socket.emit('message_error', { error: 'Message blocked: ' + validationResult.reason });
      }

      data.text = moderator.clean(data.text);

      if (!data.sender || !data.receiver) {
        return socket.emit('message_error', { error: 'Missing sender or receiver' });
      }

      const [sender, receiver] = await Promise.all([
        User.findById(data.sender).lean(),
        User.findById(data.receiver).lean()
      ]);

      if (!sender || !receiver) {
        return socket.emit('message_error', { error: 'Invalid contact selected' });
      }
      if (receiver.role === 'mentor' && receiver.chatDisabled) {
        return socket.emit('message_error', { error: 'Mentor not accepting messages' });
      }
      if (sender.role === 'user' && (sender.messageCredits || 0) <= 0) {
        return socket.emit('insufficient_credits', { message: 'Your free message limit is over.' });
      }

      // Save message
      const newMessage = await Message.create({
        sender  : data.sender,
        receiver: data.receiver,
        text    : data.text,
        status  : 'sent',
        seen    : false
      });

      // Deduct credit (non-blocking)
      if (sender.role === 'user') {
        User.findByIdAndUpdate(sender._id, { $inc: { messageCredits: -1 } })
          .catch(err => console.error('Credit deduct failed:', err.message));
      }

      // First-message totalChats increment
      const msgCount = await Message.countDocuments({
        $or: [
          { sender: data.sender, receiver: data.receiver },
          { sender: data.receiver, receiver: data.sender }
        ]
      });
      if (msgCount === 1) {
        const mentorId = receiver.role === 'mentor' ? receiver._id : sender.role === 'mentor' ? sender._id : null;
        if (mentorId) {
          User.findByIdAndUpdate(mentorId, { $inc: { totalChats: 1 } })
            .catch(err => console.error('totalChats increment failed:', err.message));
        }
      }

      const populated = await Message.findById(newMessage._id)
        .populate('sender receiver', 'username name email profilePicture')
        .lean();

      const msgForFrontend = {
        _id          : populated._id,
        sender       : populated.sender._id,
        senderName   : populated.sender.username || populated.sender.name,
        senderAvatar : populated.sender.profilePicture,
        receiver     : populated.receiver._id,
        receiverName : populated.receiver.username || populated.receiver.name,
        receiverAvatar: populated.receiver.profilePicture,
        text         : populated.text,
        createdAt    : populated.createdAt,
        status       : populated.status || 'sent',
        seen         : populated.seen || false,
        isAutoReply  : false
      };

      io.to(data.receiver).emit('receive_private_message', msgForFrontend);
      io.to(data.sender).emit('receive_private_message', msgForFrontend);

      // Delivery status
      if (userSockets.has(data.receiver)) {
        Message.findByIdAndUpdate(newMessage._id, { status: 'delivered', deliveredAt: new Date() })
          .catch(() => {});
        io.to(data.sender).emit('message_status_update', {
          messageId  : newMessage._id,
          status     : 'delivered',
          deliveredAt: new Date().toISOString()
        });
      }

      // Socket notification (once per conversation)
      const notifKey = `${data.sender}-${data.receiver}`;
      if (!pendingNotifications.has(notifKey)) {
        io.to(data.receiver).emit('chat_notification', {
          from     : msgForFrontend.sender,
          fromName : msgForFrontend.senderName,
          message  : msgForFrontend.text,
          timestamp: msgForFrontend.createdAt
        });
        pendingNotifications.set(notifKey, true);
      }

      io.to(data.sender).emit('chat_update', { type: 'new_message', messageId: newMessage._id });
      io.to(data.receiver).emit('chat_update', { type: 'new_message', messageId: newMessage._id });

      // Auto-reply for user → mentor
      if (sender.role === 'user' && receiver.role === 'mentor') {
        setTimeout(async () => {
          try {
            await sendAutoReply(io, data.sender, data.receiver, {
              username      : receiver.username,
              profilePicture: receiver.profilePicture
            });
          } catch (err) {
            console.error('Auto-reply error:', err.message);
          }
        }, 1500);
      }

      // Email notification (once, only if offline)
      const emailKey     = `email-${data.sender}-${data.receiver}`;
      const isActive     = activeUsers.get(data.receiver)?.has(data.sender);
      const isOnline     = userSockets.has(data.receiver);

      if (!isActive && !isOnline && !pendingNotifications.has(emailKey) && resend) {
        resend.emails.send({
          from   : 'notification@atyant.in',
          to     : receiver.email,
          subject: `New Message from ${sender.username}`,
          text   : `${sender.username}: "${data.text}"\n\nReply at ${allowedOrigins[0]}`
        })
          .then(() => pendingNotifications.set(emailKey, true))
          .catch(err => console.error('Email notification failed:', err.message));
      }

    } catch (error) {
      console.error('private_message error:', error);
      socket.emit('message_error', { error: 'Server error. Please try again.' });
    }
  });

  socket.on('delete_message', async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (msg && msg.sender.toString() === userId) {
        await Message.deleteOne({ _id: messageId });
        io.to(msg.sender.toString()).emit('message_deleted', { messageId });
        io.to(msg.receiver.toString()).emit('message_deleted', { messageId });
      }
    } catch (err) {
      console.error('delete_message error:', err);
    }
  });

  socket.on('message_read', async ({ messageId, sender }) => {
    try {
      await Message.findByIdAndUpdate(messageId, { status: 'read', seen: true, readAt: new Date() });
      io.to(sender).emit('message_status_update', {
        messageId,
        status : 'read',
        seen   : true,
        readAt : new Date().toISOString()
      });
    } catch (err) {
      console.error('message_read error:', err);
    }
  });

  socket.on('message_delivered', ({ messageId, sender }) => {
    io.to(sender).emit('message_status', { messageId, status: 'delivered', timestamp: new Date().toISOString() });
  });
});

// ─── Message history ───────────────────────────────────────────────────────
app.get('/api/messages/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    const messages = await Message.find({
      $or: [
        { sender: userId1, receiver: userId2 },
        { sender: userId2, receiver: userId1 }
      ]
    })
      .populate('sender receiver', 'username name')
      .sort({ createdAt: 1 })
      .lean();
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
//  🔴 FIX: Added — without this, PM2 restart leaves DB connections hanging
// ─────────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(async () => {
    await mongoose.connection.close();
    console.log('✅ MongoDB disconnected. Server closed.');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => { console.error('⚠️ Forced shutdown'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 CORS: ${allowedOrigins.join(', ')}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default server;
