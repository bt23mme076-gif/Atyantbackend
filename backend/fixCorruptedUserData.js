import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const fixCorruptedUserData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/atyant');
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // Find all users
    const users = await usersCollection.find({}).toArray();
    console.log(`📊 Found ${users.length} users to check`);

    let fixedCount = 0;

    for (const user of users) {
      let needsUpdate = false;
      const updates = {};

      // Fix city field if it's an object
      if (user.city && typeof user.city === 'object') {
        console.log(`⚠️ User ${user.username || user.email} has corrupted city field`);
        if (user.city.city && typeof user.city.city === 'string') {
          updates.city = user.city.city;
          console.log(`  → Fixed city: ${updates.city}`);
        } else {
          updates.city = '';
          console.log(`  → Cleared city field`);
        }
        needsUpdate = true;
      }

      // Fix location.city if it's an object
      if (user.location && user.location.city && typeof user.location.city === 'object') {
        console.log(`⚠️ User ${user.username || user.email} has corrupted location.city field`);
        if (user.location.city.city && typeof user.location.city.city === 'string') {
          updates['location.city'] = user.location.city.city;
          console.log(`  → Fixed location.city: ${updates['location.city']}`);
        } else {
          updates['location.city'] = null;
          console.log(`  → Cleared location.city field`);
        }
        needsUpdate = true;
      }

      // Fix location.state if it's an object
      if (user.location && user.location.state && typeof user.location.state === 'object') {
        console.log(`⚠️ User ${user.username || user.email} has corrupted location.state field`);
        updates['location.state'] = null;
        needsUpdate = true;
      }

      // Apply updates
      if (needsUpdate) {
        await usersCollection.updateOne(
          { _id: user._id },
          { $set: updates }
        );
        fixedCount++;
        console.log(`✅ Fixed user: ${user.username || user.email}`);
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📈 Cleanup Summary:');
    console.log(`   ✅ Users fixed: ${fixedCount}`);
    console.log(`   ℹ️  Total users: ${users.length}`);
    console.log('='.repeat(50));

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    process.exit(1);
  }
};

// Run the cleanup
fixCorruptedUserData();
