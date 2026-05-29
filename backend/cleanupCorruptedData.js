import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const client = new MongoClient(uri);

async function cleanupCorruptedData() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('atyant');
    const usersCollection = db.collection('users');

    // Find all users
    const users = await usersCollection.find({}).toArray();
    console.log(`📊 Found ${users.length} users to check`);

    let fixedCount = 0;
    let alreadyCleanCount = 0;

    for (const user of users) {
      let needsUpdate = false;
      const updates = {};

      // Check if city field contains an object
      if (user.city && typeof user.city === 'object') {
        console.log(`🔧 Fixing corrupted city field for user: ${user.username || user.email}`);
        updates.city = user.city.city || null;
        needsUpdate = true;
      }

      // Check if location.city contains an object
      if (user.location && user.location.city && typeof user.location.city === 'object') {
        console.log(`🔧 Fixing corrupted location.city field for user: ${user.username || user.email}`);
        updates['location.city'] = user.location.city.city || null;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await usersCollection.updateOne(
          { _id: user._id },
          { $set: updates }
        );
        fixedCount++;
        console.log(`✅ Fixed user: ${user.username || user.email}`);
      } else {
        alreadyCleanCount++;
      }
    }

    console.log('\n=== Cleanup Summary ===');
    console.log(`✅ Fixed: ${fixedCount} users`);
    console.log(`✓ Already clean: ${alreadyCleanCount} users`);
    console.log(`📊 Total checked: ${users.length} users`);

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  } finally {
    await client.close();
    console.log('🔌 MongoDB connection closed');
  }
}

cleanupCorruptedData();
