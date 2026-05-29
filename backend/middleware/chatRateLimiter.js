import rateLimit from 'express-rate-limit';

const chatRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 20, // limit each IP to 20 messages per windowMs
    message: 'Too many messages sent. Please wait a minute before sending more messages.',
    standardHeaders: true,
    legacyHeaders: false,
});

export default chatRateLimiter;