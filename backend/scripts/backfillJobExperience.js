// ─────────────────────────────────────────────────────────────────────────────
//  Backfill: tag every job with its experience level (internship / entry /
//  mid / senior / unknown), minimum years and isIndia, as JobSyncCron now does
//  on sync. Also closes the old firecrawl meesho listings (meesho now syncs
//  from its Lever board).
//
//  USAGE (from backend/ folder):
//    node scripts/backfillJobExperience.js            # write
//    node scripts/backfillJobExperience.js --dry-run  # counts only
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import mongoose from 'mongoose';
import Job from '../models/Job.js';
import { classifyJob } from '../services/ExperienceFit.js';
import { isIndiaLocation } from '../services/JobLocation.js';

const dryRun = process.argv.includes('--dry-run');

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

const counts = {};
let ops = [];
let written = 0;
for await (const job of Job.find({}).select('title descriptionText location').lean().cursor()) {
  const level = { ...classifyJob(job), isIndia: isIndiaLocation(job.location) };
  counts[level.experienceLevel] = (counts[level.experienceLevel] || 0) + 1;
  ops.push({ updateOne: { filter: { _id: job._id }, update: { $set: level } } });
  if (ops.length === 500) {
    if (!dryRun) written += (await Job.bulkWrite(ops)).modifiedCount;
    ops = [];
  }
}
if (ops.length && !dryRun) written += (await Job.bulkWrite(ops)).modifiedCount;

if (!dryRun) {
  const old = await Job.updateMany({ source: 'firecrawl', company: 'meesho', status: 'open' }, { $set: { status: 'closed' } });
  console.log('closed old firecrawl meesho jobs:', old.modifiedCount);
}
console.log(dryRun ? 'DRY RUN' : `updated ${written} jobs`, counts);
await mongoose.disconnect();
