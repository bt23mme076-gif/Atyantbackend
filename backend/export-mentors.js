// ─── ATYANT MENTOR EXPORT SCRIPT ───────────────────────────────────────────
// Dono collections se mentor data CSV mein export karta hai:
//   1. users collection  (role: "mentor")
//   2. mentors collection
//
// Usage:
//   1. MONGODB_URI environment variable set karo (ya neeche hardcode karo)
//   2. node export-mentors.js
//   3. mentors_export.csv file ban jaayegi same folder mein
// ────────────────────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import 'dotenv/config';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'YOUR_MONGODB_ATLAS_URI_HERE';

const OUTPUT_FILE = 'mentors_export.csv';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  role           : String,
  username       : String,
  email          : String,
  phone          : String,
  bio            : String,
  profilePicture : String,
  profileStrength: Number,
  primaryDomain  : String,
  companyDomain  : String,
  topCompanies   : [String],
  milestones     : [String],
  specialTags    : [String],
  expertise      : [String],
  skills         : [String],
  interests      : [String],
  rating         : Number,
  responseRate   : Number,
  totalChats     : Number,
  profileViews   : Number,
  successfulMatches: Number,
  isVerified     : Boolean,
  isOnline       : Boolean,
  city           : String,
  linkedinProfile: String,
  yearsOfExperience: Number,
  tier           : Number,
  price          : Number,
  acceptsCredits : Boolean,
  education      : [{
    institutionName: String,
    institution    : String,
    degree         : String,
    field          : String,
    year           : String,
    cgpa           : Number,
  }],
  location: {
    city   : String,
    state  : String,
    country: String,
  },
  lastActive: Date,
  lastLogin : Date,
  createdAt : Date,
}, { timestamps: true });

const mentorSchema = new mongoose.Schema({
  username      : String,
  name          : String,
  email         : String,
  bio           : String,
  expertise     : [String],
  profilePicture: String,
  location: {
    city : String,
    state: String,
    country: String,
  },
  ratings: [{
    rating: Number,
    review: String,
    createdAt: Date,
  }],
  createdAt: Date,
}, { timestamps: true });

// ─── HELPERS ────────────────────────────────────────────────────────────────

// Profile fields kitne fill hue — percentage calculate karta hai
function calcProfileFilled(user) {
  const fields = [
    'username', 'email', 'phone', 'bio', 'profilePicture',
    'city', 'linkedinProfile', 'primaryDomain', 'companyDomain',
  ];
  const arrayFields = ['topCompanies', 'expertise', 'skills', 'interests', 'education'];

  let filled = 0;
  const total = fields.length + arrayFields.length;

  fields.forEach(f => {
    if (user[f] && String(user[f]).trim() !== '') filled++;
  });
  arrayFields.forEach(f => {
    const val = user[f];
    if (Array.isArray(val) && val.length > 0) filled++;
  });

  return `${filled}/${total} (${Math.round((filled / total) * 100)}%)`;
}

// CSV cell ko safely escape karta hai
function csvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/\r?\n/g, ' ').trim();
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Education array ko readable string mein convert karta hai
function formatEducation(edu) {
  if (!edu || edu.length === 0) return '';
  return edu.map(e => {
    const inst = e.institutionName || e.institution || '';
    const parts = [inst, e.degree, e.field, e.year, e.cgpa ? `CGPA: ${e.cgpa}` : '']
      .filter(Boolean);
    return parts.join(' | ');
  }).join(' ;; ');
}

// Average rating nikalta hai mentors collection ke ratings array se
function avgRating(ratings) {
  if (!ratings || ratings.length === 0) return '';
  const avg = ratings.reduce((sum, r) => sum + (r.rating || 0), 0) / ratings.length;
  return avg.toFixed(2);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (MONGODB_URI === 'YOUR_MONGODB_ATLAS_URI_HERE') {
    console.error('❌  MONGODB_URI set nahi hai!');
    console.error('   Ya toh MONGODB_URI env variable set karo:');
    console.error('   MONGODB_URI="mongodb+srv://..." node export-mentors.js');
    console.error('   Ya seedha script ke upar MONGODB_URI mein paste karo.');
    process.exit(1);
  }

  console.log('🔌  MongoDB Atlas se connect ho raha hoon...');
  await mongoose.connect(MONGODB_URI, { dbName: undefined }); // dbName URI se lega
  console.log('✅  Connected!');

  const User   = mongoose.model('User',   userSchema);
  const Mentor = mongoose.model('Mentor', mentorSchema);

  // ── 1. users collection se role=mentor wale fetch karo ──────────────────
  console.log('\n📦  users collection se mentors fetch kar raha hoon...');
  const userMentors = await User.find({ role: 'mentor' }).lean();
  console.log(`   Mila: ${userMentors.length} mentors`);

  // ── 2. mentors collection se sab fetch karo ─────────────────────────────
  console.log('📦  mentors collection se data fetch kar raha hoon...');
  const mentorDocs = await Mentor.find({}).lean();
  console.log(`   Mila: ${mentorDocs.length} documents`);

  // ─── CSV ROWS BANAO ─────────────────────────────────────────────────────

  // CSV Headers
  const headers = [
    'Source',
    'ID',
    'Username',
    'Name',
    'Email',
    'Phone',
    'Bio',
    'City',
    'State',
    'Country',
    'LinkedIn',
    'Profile Picture',
    'Primary Domain',
    'Company Domain',
    'Top Companies',
    'Milestones',
    'Special Tags',
    'Expertise',
    'Skills',
    'Interests',
    'Education',
    'Years of Experience',
    'Tier',
    'Rating',
    'Response Rate (%)',
    'Total Chats',
    'Profile Views',
    'Successful Matches',
    'Is Verified',
    'Is Online',
    'Accepts Credits',
    'Price',
    'Profile Strength (DB)',
    'Profile Fields Filled',
    'Last Active',
    'Last Login',
    'Created At',
  ];

  const rows = [];

  // users collection rows
  for (const u of userMentors) {
    const loc = u.location || {};
    rows.push([
      'users_collection',
      u._id,
      u.username || '',
      '',                                          // name field nahi hai users mein
      u.email || '',
      u.phone || '',
      u.bio || '',
      u.city || loc.city || '',
      loc.state || '',
      loc.country || '',
      u.linkedinProfile || '',
      u.profilePicture || '',
      u.primaryDomain || '',
      u.companyDomain || '',
      (u.topCompanies || []).join('; '),
      (u.milestones || []).join('; '),
      (u.specialTags || []).join('; '),
      (u.expertise || []).join('; '),
      (u.skills || []).join('; '),
      (u.interests || []).join('; '),
      formatEducation(u.education),
      u.yearsOfExperience ?? '',
      u.tier ?? '',
      u.rating ?? '',
      u.responseRate ?? '',
      u.totalChats ?? '',
      u.profileViews ?? '',
      u.successfulMatches ?? '',
      u.isVerified ? 'Yes' : 'No',
      u.isOnline ? 'Yes' : 'No',
      u.acceptsCredits ? 'Yes' : 'No',
      u.price ?? '',
      u.profileStrength ?? '',
      calcProfileFilled(u),
      u.lastActive ? new Date(u.lastActive).toISOString() : '',
      u.lastLogin  ? new Date(u.lastLogin).toISOString()  : '',
      u.createdAt  ? new Date(u.createdAt).toISOString()  : '',
    ].map(csvCell));
  }

  // mentors collection rows
  for (const m of mentorDocs) {
    const loc = m.location || {};
    rows.push([
      'mentors_collection',
      m._id,
      m.username || '',
      m.name     || '',
      m.email    || '',
      '',                                          // phone nahi hai mentor schema mein
      m.bio || '',
      loc.city    || '',
      loc.state   || '',
      loc.country || '',
      '',                                          // linkedin nahi hai mentor schema mein
      m.profilePicture || '',
      '', '', '', '', '',                          // domain fields nahi hain
      (m.expertise || []).join('; '),
      '', '',                                      // skills, interests nahi hain
      '',                                          // education nahi hai
      '', '',                                      // yearsOfExp, tier nahi hain
      avgRating(m.ratings),
      '', '', '', '',                              // responseRate, totalChats etc nahi hain
      '', '', '', '', '',                          // isVerified, isOnline, etc nahi hain
      '',                                          // profileStrength nahi hai
      '',                                          // calcProfileFilled — schema alag hai
      '',                                          // lastActive nahi hai
      '',                                          // lastLogin nahi hai
      m.createdAt ? new Date(m.createdAt).toISOString() : '',
    ].map(csvCell));
  }

  // ─── CSV FILE LIKHNA ────────────────────────────────────────────────────
  const csvContent = [
    headers.map(csvCell).join(','),
    ...rows.map(r => r.join(',')),
  ].join('\n');

  const outputPath = path.resolve(OUTPUT_FILE);
  fs.writeFileSync(outputPath, '\uFEFF' + csvContent, 'utf8'); // BOM for Excel UTF-8

  console.log(`\n✅  CSV ban gayi: ${outputPath}`);
  console.log(`   Total rows: ${rows.length} (users: ${userMentors.length}, mentors: ${mentorDocs.length})`);
  console.log('\n📊  Quick summary:');

  // Verified count
  const verified = userMentors.filter(u => u.isVerified).length;
  console.log(`   Verified mentors: ${verified}/${userMentors.length}`);

  // Profile strength average
  const strengths = userMentors.map(u => u.profileStrength || 0);
  const avgStrength = strengths.length
    ? (strengths.reduce((a, b) => a + b, 0) / strengths.length).toFixed(1)
    : 0;
  console.log(`   Avg profile strength: ${avgStrength}%`);

  // Domain breakdown
  const domains = {};
  userMentors.forEach(u => {
    const d = u.primaryDomain || 'null';
    domains[d] = (domains[d] || 0) + 1;
  });
  console.log('   Primary domain breakdown:', domains);

  await mongoose.disconnect();
  console.log('\n🔌  Disconnected. Done!');
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  mongoose.disconnect();
  process.exit(1);
});