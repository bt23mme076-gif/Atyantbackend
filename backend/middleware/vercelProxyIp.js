import crypto from 'crypto';
import net from 'net';

// Requests that come through the www.atyant.in/api/* rewrite reach us from
// Vercel's IPs; the visitor's own address is in x-vercel-forwarded-for.
// Traefik passes that header through untouched from anyone, so it is trusted
// only when x-atyant-proxy-secret matches VERCEL_PROXY_SECRET (added by the
// frontend's Vercel middleware). Unset secret = disabled, req.ip unchanged.
const SECRET = process.env.VERCEL_PROXY_SECRET || '';
const SECRET_BUF = Buffer.from(SECRET);

const secretMatches = (got) => {
  const buf = Buffer.from(String(got));
  return buf.length === SECRET_BUF.length && crypto.timingSafeEqual(buf, SECRET_BUF);
};

export function vercelProxyIp(req, res, next) {
  const got = req.headers['x-atyant-proxy-secret'];
  delete req.headers['x-atyant-proxy-secret'];
  if (SECRET && got && secretMatches(got)) {
    const client = String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0].trim();
    if (net.isIP(client)) {
      Object.defineProperty(req, 'ip', { value: client, configurable: true, enumerable: true });
      req.viaVercel = true;
    }
  }
  next();
}
