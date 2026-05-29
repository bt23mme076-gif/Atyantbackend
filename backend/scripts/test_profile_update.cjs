const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'routes', 'profileRoutes.js');
if (!fs.existsSync(file)) {
  console.error('Target file not found:', file);
  process.exit(2);
}
const src = fs.readFileSync(file, 'utf8');
const hasCreditsDelete = /delete\s+updateData\.credits/.test(src);
const hasMessageCreditsDelete = /delete\s+updateData\.messageCredits/.test(src);
if (hasCreditsDelete && hasMessageCreditsDelete) {
  console.log('PASS: credit deletion lines present');
  process.exit(0);
} else {
  console.error('FAIL: missing deletion lines', { hasCreditsDelete, hasMessageCreditsDelete });
  process.exit(1);
}
