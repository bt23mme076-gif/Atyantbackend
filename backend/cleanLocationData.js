import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const cleanLocationData = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    
    // ✅ FIX: Check multiple possible variable names
    const mongoURI = process.env.MONGODB_URI || 
                     process.env.MONGO_URI || 
                     process.env.DATABASE_URL ||
                     process.env.DB_URI;
    
    if (!mongoURI) {
      console.error('❌ Error: MongoDB connection string not found in .env file');
      console.log('💡 Add one of these to your .env file:');
      console.log('   MONGODB_URI=your_connection_string');
      console.log('   or');
      console.log('   MONGO_URI=your_connection_string');
      process.exit(1);
    }
    
    console.log('📡 Using MongoDB URI:', mongoURI.substring(0, 30) + '...');
    
    await mongoose.connect(mongoURI);
    console.log('✅ Connected!');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // Remove invalid location data
    const result = await usersCollection.updateMany(
      {
        'location': { $exists: true },
        $or: [
          { 'location.coordinates': { $exists: false } },
          { 'location.coordinates': null },
          { 'location.coordinates': [] },
          { 'location.coordinates': { $type: 'object' } }
        ]
      },
      {
        $unset: { location: "" }
      }
    );

    console.log(`✅ Cleaned ${result.modifiedCount} user records with invalid location data`);

    // Create geospatial index if not exists
    const indexes = await usersCollection.indexes();
    const hasGeoIndex = indexes.some(idx => idx.key && idx.key.location === '2dsphere');
    
    if (!hasGeoIndex) {
      console.log('🔨 Creating geospatial index...');
      await usersCollection.createIndex({ location: '2dsphere' });
      console.log('✅ Geospatial index created');
    } else {
      console.log('✅ Geospatial index already exists');
    }

    // Count valid mentors
    const validMentors = await usersCollection.countDocuments({
      role: 'mentor',
      'location.coordinates': { $exists: true, $type: 'array', $size: 2 }
    });

    console.log(`\n📍 Mentors with valid location: ${validMentors}`);

    await mongoose.connection.close();
    console.log('\n✅ Cleanup complete! You can now update your profile.');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

cleanLocationData();