// ✅ FIX #5: Global rate limiter (memory-based, upgrade to Redis for production)

const rateMap = new Map();
const WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS = 100; // 100 requests per minute per IP (increased for community chat)

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateMap.entries()) {
    if (now - data.time > WINDOW_MS * 2) {
      rateMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

export function globalRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  const data = rateMap.get(ip) || { count: 0, time: now };

  // Reset window if expired
  if (now - data.time > WINDOW_MS) {
    data.count = 1;
    data.time = now;
  } else {
    data.count++;
  }

  rateMap.set(ip, data);

  // Block if over limit
  if (data.count > MAX_REQUESTS) {
    console.warn(`⚠️ Rate limit exceeded: ${ip} (${data.count} requests)`);
    return res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.'
    });
  }

  next();
}

export default globalRateLimit;
