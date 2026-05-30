import mongoose from 'mongoose';

const mentorSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String },
  bio: { type: String },
  expertise: [{ type: String, trim: true }],
  profilePicture: { type: String },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    // GeoJSON coordinates: [longitude, latitude]
    coordinates: {
      type: [Number],
      validate: {
        validator: v => !v || v.length === 0 || (Array.isArray(v) && v.length === 2 && !isNaN(v[0]) && !isNaN(v[1])),
        message: 'Coordinates must be [longitude, latitude]'
      }
    },
    city: String,
    state: String,
    country: String,
    lastUpdated: { type: Date, default: null }
  },
  ratings: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: Number,
    review: String,
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// 2dsphere index for geospatial queries
mentorSchema.index({ 'location.coordinates': '2dsphere' }, { sparse: true });

// Helper to normalize legacy location formats into GeoJSON coordinates ([lon, lat])
function _ensureCoordinates(doc) {
  try {
    if (!doc) return;
    const loc = doc.location;
    if (!loc) return;

    // Already normalized
    if (Array.isArray(loc.coordinates) && loc.coordinates.length === 2) return;

    // Legacy: coordinates stored as object { lat, lon } or { latitude, longitude }
    if (loc.coordinates && typeof loc.coordinates === 'object') {
      const maybeLat = loc.coordinates.lat ?? loc.coordinates.latitude ?? loc.coordinates[1];
      const maybeLon = loc.coordinates.lon ?? loc.coordinates.longitude ?? loc.coordinates[0];
      const lat = parseFloat(maybeLat);
      const lon = parseFloat(maybeLon);
      if (!isNaN(lat) && !isNaN(lon)) {
        loc.coordinates = [lon, lat];
      }
      return;
    }

    // Legacy: top-level lat/lon on location
    if (typeof loc.lat !== 'undefined' || typeof loc.lon !== 'undefined') {
      const lat = parseFloat(loc.lat);
      const lon = parseFloat(loc.lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        loc.coordinates = [lon, lat];
      }
      return;
    }
  } catch (err) {
    // swallow — normalization is best-effort and non-destructive
  }
}

// Normalize results after loading from DB so application code sees consistent format.
mentorSchema.post('init', function(doc) {
  _ensureCoordinates(doc);
});
mentorSchema.post('find', function(docs) {
  if (Array.isArray(docs)) docs.forEach(_ensureCoordinates);
});
mentorSchema.post('findOne', function(doc) {
  if (doc) _ensureCoordinates(doc);
});

// Instance helper to get normalized coordinates
mentorSchema.methods.getCoordinates = function() {
  if (!this.location) return null;
  if (Array.isArray(this.location.coordinates) && this.location.coordinates.length === 2) return this.location.coordinates;
  // attempt to normalize in-memory
  const loc = this.location;
  if (loc.coordinates && typeof loc.coordinates === 'object') {
    const lat = parseFloat(loc.coordinates.lat ?? loc.coordinates.latitude ?? 0);
    const lon = parseFloat(loc.coordinates.lon ?? loc.coordinates.longitude ?? 0);
    if (!isNaN(lat) && !isNaN(lon)) return [lon, lat];
  }
  if (typeof loc.lat !== 'undefined' || typeof loc.lon !== 'undefined') {
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);
    if (!isNaN(lat) && !isNaN(lon)) return [lon, lat];
  }
  return null;
};

const Mentor = mongoose.model('Mentor', mentorSchema);
export default Mentor;