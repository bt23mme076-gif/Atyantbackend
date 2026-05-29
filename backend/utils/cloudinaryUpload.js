// backend/utils/cloudinaryUpload.js
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';


// Check for required Cloudinary environment variables
const missingVars = [];
if (!process.env.CLOUD_NAME) missingVars.push('CLOUD_NAME');
if (!process.env.CLOUDINARY_API_KEY) missingVars.push('CLOUDINARY_API_KEY');
if (!process.env.CLOUDINARY_API_SECRET) missingVars.push('CLOUDINARY_API_SECRET');
if (missingVars.length > 0) {
  throw new Error('Cloudinary config error: Missing environment variables: ' + missingVars.join(', '));
}

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Uploads a local audio file to Cloudinary and returns the public URL.
 * @param {string} localFilePath - Path to the local audio file
 * @param {string} [folder='mentor-voice-answers'] - Cloudinary folder
 * @returns {Promise<string>} - The Cloudinary public URL
 */
export async function uploadAudioToCloudinary(localFilePath, folder = 'mentor-voice-answers') {
  const result = await cloudinary.uploader.upload(localFilePath, {
    resource_type: 'video', // audio files are uploaded as 'video' type
    folder,
  });
  // Optionally delete local file after upload
  fs.unlink(localFilePath, () => {});
  return result.secure_url;
}
