import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log('✅ Connected to MongoDB');

const db = mongoose.connection.db;

// 1. Kitne mentors hain total
const total = await db.collection('users').countDocuments({ role: 'mentor' });
console.log(`📊 Total mentors: ${total}`);

// 2. Kitne bina lastActive ke hain
const missingLastActive = await db.collection('users').countDocuments({ 
  role: 'mentor', 
  $or: [{ lastActive: { $exists: false } }, { lastActive: null }]
});
console.log(`⚠️  Mentors without lastActive: ${missingLastActive}`);

// 3. Fix karo - lastActive set karo
const result1 = await db.collection('users').updateMany(
  { role: 'mentor', $or: [{ lastActive: { $exists: false } }, { lastActive: null }] },
  { $set: { lastActive: new Date('2025-01-01') } }
);
console.log(`✅ Fixed lastActive: ${result1.modifiedCount} mentors updated`);

// 4. Index banao
await db.collection('users').createIndex({ role: 1, lastActive: 1 });
await db.collection('users').createIndex({ role: 1, activeQuestions: 1 });
console.log('✅ Indexes created');

// 5. Final check - ab kitne mentors query mein aayenge
const now = new Date();
const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
const qualifying = await db.collection('users').countDocuments({
  role: 'mentor',
  lastActive: { $gte: ninetyDaysAgo }
});
console.log(`🎯 Mentors qualifying for routing now: ${qualifying}`);

await mongoose.disconnect();
console.log('Done!');