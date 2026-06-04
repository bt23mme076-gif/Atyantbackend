// One-off: generate a branded 1200x630 default OG image and upload it to Cloudinary.
// Run once:  node scripts/uploadOgDefault.js
// Then put the returned URL in .env as OG_DEFAULT_IMAGE.
import cloudinary from '../config/cloudinary.js';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1020"/>
      <stop offset="1" stop-color="#1b1340"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="600" y="300" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="700" fill="#ffffff" text-anchor="middle">Atyant</text>
  <text x="600" y="380" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="#a78bfa" text-anchor="middle">Mentorship that gets you hired</text>
</svg>`;

const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const res = await cloudinary.uploader.upload(dataUri, {
  public_id: 'atyant/og-default',
  overwrite: true,
  format: 'png',
});

console.log('\nUploaded. Put this in .env:\n');
console.log(`OG_DEFAULT_IMAGE=${res.secure_url}\n`);
