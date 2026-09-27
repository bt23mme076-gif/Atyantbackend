import 'dotenv/config';
import fs from 'fs/promises';
import mongoose from 'mongoose';
import User from '../models/User.js';

const outputPath = new URL('../../users_sheet.csv', import.meta.url);

function csvValue(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

try {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({ role: 'user' })
    .select('name username email -_id')
    .sort({ name: 1, email: 1 })
    .lean();

  const rows = [
    ['User', 'User Gmail'],
    ...users.map(({ name, username, email }) => [name || username || '', email]),
  ];

  await fs.writeFile(
    outputPath,
    `${rows.map(row => row.map(csvValue).join(',')).join('\n')}\n`,
    'utf8',
  );

  console.log(`Created ${users.length} user rows at ${outputPath.pathname}`);
} finally {
  await mongoose.disconnect();
}