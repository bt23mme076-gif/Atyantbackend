import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Mentor from '../models/Mentor.js';

dotenv.config();

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const logArg = argv.find(a => a.startsWith('--log='));
const logPath = logArg ? logArg.split('=')[1] : null;
const batchArg = argv.find(a => a.startsWith('--batch='));
const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : 500;

async function migrate() {
  const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoURI) {
    console.error('MONGO_URI not set in environment. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(mongoURI, { maxPoolSize: 5 });
  console.log('Connected to MongoDB');

  // Use a cursor to process mentors in batches to avoid high memory usage
  const cursor = Mentor.find().lean().cursor();
  console.log('Streaming mentors via cursor...');

  let updated = 0;
  const logLines = [];
  let batchCount = 0;
  let processed = 0;
  const batchDelayMs = 100; // small pause between batches

  for await (const m of cursor) {
    processed++;
    try {
      const loc = m.location;
      if (loc && Array.isArray(loc.coordinates) && loc.coordinates.length === 2) {
        // already correct
      } else if (loc && loc.coordinates && typeof loc.coordinates === 'object' && ('lat' in loc.coordinates || 'lon' in loc.coordinates)) {
        const lat = parseFloat(loc.coordinates.lat || loc.coordinates.latitude || 0);
        const lon = parseFloat(loc.coordinates.lon || loc.coordinates.longitude || 0);
        if (!isNaN(lat) && !isNaN(lon)) {
          const updateObj = {
            'location.type': 'Point',
            'location.coordinates': [lon, lat],
            'location.city': loc.city || m.city || null,
            'location.state': loc.state || null,
            'location.country': loc.country || 'India',
            'location.lastUpdated': new Date()
          };

          if (dryRun) {
            console.log(`[dry-run] Would update mentor ${m._id} -> [${lon}, ${lat}]`);
            logLines.push(`${m._id},${m.username || ''},${lon},${lat}`);
          } else {
            await Mentor.updateOne({ _id: m._id }, { $set: updateObj });
            updated++;
            logLines.push(`${m._id},${m.username || ''},${lon},${lat}`);
          }
        }
      }
    } catch (err) {
      console.error('Error migrating mentor', m._id, err.message);
    }

    // batch delay
    batchCount++;
    if (batchCount >= batchSize) {
      batchCount = 0;
      console.log(`Processed ${processed} mentors so far...`);
      await new Promise(r => setTimeout(r, batchDelayMs));
    }
  }

  console.log(`Finished streaming ${processed} mentors`);

  if (logPath && logLines.length > 0) {
    const header = 'mentorId,username,lon,lat\n';
    fs.writeFileSync(path.resolve(logPath), header + logLines.join('\n'));
    console.log(`Wrote log to ${logPath}`);
  }
  // Create 2dsphere index on location.coordinates if applying changes
  if (!dryRun) {
    try {
      console.log('Creating 2dsphere index on location.coordinates (sparse)...');
      await Mentor.collection.createIndex({ 'location.coordinates': '2dsphere' }, { sparse: true });
      console.log('2dsphere index created.');
    } catch (idxErr) {
      console.error('Failed to create 2dsphere index:', idxErr.message);
    }
  }

  console.log(`Migration complete. ${dryRun ? 'Dry-run: no changes applied.' : `Updated ${updated} mentors.`}`);
  await mongoose.connection.close();
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
