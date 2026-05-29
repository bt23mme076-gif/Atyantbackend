import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import User from '../models/User.js';

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Google OAuth Strategy
// Only initialize if credentials are properly configured
if (process.env.GOOGLE_CALENDAR_CLIENT_ID && 
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET && 
    process.env.GOOGLE_CALLBACK_URL) {
  
  console.log('🔧 Initializing Google OAuth Strategy...');
  console.log('   Client ID:', process.env.GOOGLE_CALENDAR_CLIENT_ID?.substring(0, 20) + '...');
  console.log('   Callback URL:', process.env.GOOGLE_CALLBACK_URL);
  
  try {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
          callbackURL: process.env.GOOGLE_CALLBACK_URL,
          scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/calendar.events'
          ]
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            let user = await User.findOne({ googleId: profile.id });

            if (user) {
              // Update existing user tokens
              user.accessToken = accessToken;
              if (refreshToken) user.refreshToken = refreshToken;
              user.lastLogin = new Date();
              user.calendarConnected = true;
              user.calendarProvider = 'google';
              await user.save();
              console.log('✅ Existing OAuth user logged in:', user.email);
            } else {
              // Check if user exists with this email
              user = await User.findOne({ email: profile.emails[0].value });
              
              if (user) {
                // Link Google account to existing user
                user.googleId = profile.id;
                user.accessToken = accessToken;
                if (refreshToken) user.refreshToken = refreshToken;
                user.lastLogin = new Date();
                if (!user.profilePicture && profile.photos?.[0]?.value) {
                  user.profilePicture = profile.photos[0].value;
                }
                user.calendarConnected = true;
                user.calendarProvider = 'google';
                await user.save();
                console.log('✅ Linked Google account to existing user:', user.email);
              } else {
                // Create new user - generate username from email or name
                let baseUsername = profile.emails[0].value.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
                let username = baseUsername;
                let counter = 1;
                
                // Ensure unique username
                while (await User.findOne({ username })) {
                  username = `${baseUsername}${counter}`;
                  counter++;
                }
                
                user = await User.create({
                  googleId: profile.id,
                  email: profile.emails[0].value,
                  username: username,
                  name: profile.displayName,
                  profilePicture: profile.photos?.[0]?.value || null,
                  picture: profile.photos?.[0]?.value || null,
                  accessToken: accessToken,
                  refreshToken: refreshToken,
                  lastLogin: new Date(),
                  role: 'user',
                  calendarConnected: true,
                  calendarProvider: 'google'
                });
                console.log('✅ Created new OAuth user:', user.email);
              }
            }

            return done(null, user);
          } catch (error) {
            console.error('❌ Google OAuth strategy error:', error);
            return done(error, null);
          }
        }
      )
    );
    console.log('✅ Google OAuth Strategy initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Google OAuth Strategy:', error.message);
  }
} else {
  console.warn('⚠️  Google OAuth disabled - missing credentials in .env');
  console.warn('   Required: GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALLBACK_URL');
}