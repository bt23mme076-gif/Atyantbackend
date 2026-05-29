import express from 'express';
const router = express.Router();
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';

const isDev = process.env.NODE_ENV === 'development';

// ✅ PERFORMANCE: Cache geocoding results
const geocodeCache = new Map();
const GEOCODE_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// ✅ Test endpoint
router.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Location routes are working!',
    timestamp: new Date()
  });
});

// ========== UPDATE USER LOCATION ==========
router.post('/update-location', protect, async (req, res) => {
  try {
    const { latitude, longitude, city, state, country } = req.body;
    const userId = req.user.userId || req.user.id;

    if (isDev) {
      console.log('📍 POST /update-location - User:', userId);
    }

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required'
      });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinates'
      });
    }

    let finalCity = city;
    let finalState = state;
    let finalCountry = country || 'India';
    let finalDistrict = '';

    // ========== GEOCODING WITH CACHING ==========
    if (!city) {
      const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const cached = geocodeCache.get(cacheKey);

      // ✅ Return cached geocoding result if available
      if (cached && (Date.now() - cached.timestamp < GEOCODE_CACHE_DURATION)) {
        finalCity = cached.city;
        finalDistrict = cached.district;
        finalState = cached.state;
        finalCountry = cached.country;
        
        if (isDev) {
          console.log('✅ Using cached geocoding result');
        }
      } else {
        try {
          if (isDev) console.log('🔍 Fetching location from Nominatim...');
          
          const geoResponse = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14&addressdetails=1`,
            {
              headers: {
                'User-Agent': 'AtyantMentorApp/1.0'
              }
            }
          );

          if (geoResponse.ok) {
            const data = await geoResponse.json();
            
            const village = data.address?.village;
            const hamlet = data.address?.hamlet;
            const locality = data.address?.locality;
            const town = data.address?.town;
            const cityName = data.address?.city;
            const county = data.address?.county;

            if (village) {
              finalCity = village;
            } else if (hamlet) {
              finalCity = hamlet;
            } else if (locality) {
              finalCity = locality;
            } else if (town) {
              finalCity = town;
            } else if (cityName) {
              finalCity = cityName;
            } else if (county) {
              finalCity = county;
            } else {
              finalCity = 'Unknown Location';
            }

            finalDistrict = data.address?.state_district || '';
            finalState = data.address?.state || 'Madhya Pradesh';
            finalCountry = data.address?.country || 'India';

            // ✅ Cache the geocoding result
            geocodeCache.set(cacheKey, {
              city: finalCity,
              district: finalDistrict,
              state: finalState,
              country: finalCountry,
              timestamp: Date.now()
            });

            // ✅ Limit cache size to prevent memory issues
            if (geocodeCache.size > 1000) {
              const firstKey = geocodeCache.keys().next().value;
              geocodeCache.delete(firstKey);
            }

          } else {
            finalCity = `Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
          }

        } catch (geoError) {
          if (isDev) console.error('❌ Geocoding error:', geoError.message);
          finalCity = `Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
        }
      }
    }

    // ========== SAVE TO DATABASE ==========
    const existingUser = await User.findById(userId);
    
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    existingUser.location = {
      type: 'Point',
      coordinates: [parseFloat(longitude), parseFloat(latitude)],
      city: finalCity,
      district: finalDistrict,
      state: finalState,
      country: finalCountry,
      lastUpdated: new Date()
    };

    await existingUser.save();

    if (isDev) {
      console.log('✅ Location saved:', finalCity);
    }

    res.json({
      success: true,
      message: 'Location updated successfully',
      location: existingUser.location
    });

  } catch (error) {
    console.error('❌ Error updating location:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update location'
    });
  }
});

// ========== GET USER LOCATION ==========
router.get('/my-location', protect, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    
    // ✅ PERFORMANCE: Only select needed fields
    const user = await User.findById(userId)
      .select('location username')
      .lean(); // ✅ Returns plain JS object (faster)
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.location || !user.location.coordinates || user.location.coordinates.length === 0) {
      return res.status(200).json({
        success: true,
        hasLocation: false,
        message: 'No location saved'
      });
    }

    res.json({
      success: true,
      hasLocation: true,
      location: user.location
    });

  } catch (error) {
    console.error('Error fetching location:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// ========== NEARBY MENTORS ==========
router.post('/nearby', protect, async (req, res) => {
  try {
    const { latitude, longitude, maxDistance = 50000 } = req.body; // ✅ Use maxDistance
    const userId = req.user.userId || req.user.id;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude required'
      });
    }

    console.log('\n========================================');
    console.log('🔍 BACKEND: Finding nearby mentors');
    console.log('📍 Search Center:', { latitude, longitude });
    console.log('🔍 Max Distance:', maxDistance / 1000, 'km');
    console.log('========================================\n');

    // ✅ PERFORMANCE: Use geospatial query with lean()
    const nearbyMentors = await User.find({
      role: 'mentor',
      _id: { $ne: userId },
      'location.coordinates': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(longitude), parseFloat(latitude)]
          },
          $maxDistance: maxDistance // ✅ Use the passed radius
        }
      }
    })
    .select('username profilePicture bio city expertise location isOnline')
    .lean()
    .limit(50);

    console.log(`✅ Found ${nearbyMentors.length} mentors in ${maxDistance / 1000}km radius`);

    // ✅ Calculate distances with proper distanceText
    const mentorsWithDistance = nearbyMentors.map(mentor => {
      if (mentor.location && mentor.location.coordinates) {
        const [lon, lat] = mentor.location.coordinates;
        const distanceInMeters = calculateDistance(latitude, longitude, lat, lon);
        
        // ✅ Format distance text properly
        let distanceText;
        if (distanceInMeters < 1000) {
          distanceText = `${Math.round(distanceInMeters)}m away`;
        } else if (distanceInMeters < 10000) {
          distanceText = `${(distanceInMeters / 1000).toFixed(1)} km away`;
        } else {
          distanceText = `${Math.round(distanceInMeters / 1000)} km away`;
        }

        console.log(`- ${mentor.username}: ${distanceText}`);

        return {
          ...mentor,
          distance: distanceInMeters, // Raw distance in meters
          distanceText: distanceText  // ✅ Formatted text
        };
      }
      return {
        ...mentor,
        distance: null,
        distanceText: 'Location not set'
      };
    });

    // Sort by distance (nearest first)
    mentorsWithDistance.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));

    res.json({
      success: true,
      count: mentorsWithDistance.length,
      mentors: mentorsWithDistance
    });

  } catch (error) {
    console.error('❌ Error finding nearby mentors:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to find nearby mentors'
    });
  }
});

// ✅ Haversine formula - Calculate distance between two points
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in meters
  
  return distance;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}

export default router;