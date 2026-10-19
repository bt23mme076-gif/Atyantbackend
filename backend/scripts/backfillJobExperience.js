// ─────────────────────────────────────────────────────────────────────────────
//  Backfill: tag every job with its experience level (internship / entry /
//  mid / senior / unknown) and minimum years, as JobSyncCron now does on sync.
//
//  USAGE (from backend/ folder):
//    node scripts/backfillJobExperience.js            # write
//    node scripts/backfillJobExperience.js --dry-run  # counts only
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import Job from '../models/Job.js';
import { classifyJob } from '../services/ExperienceFit.js';

const dryRun = process.argv.includes('--dry-run');

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

const counts = {};
let ops = [];
let written = 0;
for await (const job of Job.find({}).select('title descriptionText').lean().cursor()) {
  const level = classifyJob(job);
  counts[level.experienceLevel] = (counts[level.experienceLevel] || 0) + 1;
  ops.push({ updateOne: { filter: { _id: job._id }, update: { $set: level } } });
  if (ops.length === 500) {
    if (!dryRun) written += (await Job.bulkWrite(ops)).modifiedCount;
    ops = [];
  }
}
if (ops.length && !dryRun) written += (await Job.bulkWrite(ops)).modifiedCount;

console.log(dryRun ? 'DRY RUN' : `updated ${written} jobs`, counts);
await mongoose.disconnect();
