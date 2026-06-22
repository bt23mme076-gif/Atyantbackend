import User from '../models/User.js';

/**
 * Generate a URL-friendly slug from a name
 * Rules:
 * - lowercase
 * - remove spaces, replace with hyphens
 * - remove special characters
 * - handle duplicates by appending -1, -2, etc.
 * 
 * @param {string} name - The name to generate slug from
 * @param {string} [existingSlug] - Optional existing slug to avoid conflicts
 * @returns {Promise<string>} The generated unique slug
 */
export async function generateSlug(name, existingSlug = null) {
  if (!name) {
    throw new Error('Name is required to generate slug');
  }

  // Generate base slug: lowercase, remove special chars, replace spaces with hyphens
  let baseSlug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .substring(0, 100); // Max 100 characters

  if (!baseSlug) {
    throw new Error('Could not generate valid slug from name');
  }

  // If this is the same as existing slug, return it (no change)
  if (existingSlug && existingSlug === baseSlug) {
    return existingSlug;
  }

  // Check if base slug is unique
  const existing = await User.findOne({ slug: baseSlug }).select('slug').lean();
  if (!existing) {
    return baseSlug;
  }

  // Handle duplicates by appending -1, -2, etc.
  let counter = 1;
  let uniqueSlug;
  
  while (true) {
    uniqueSlug = `${baseSlug}-${counter}`;
    const exists = await User.findOne({ slug: uniqueSlug }).select('slug').lean();
    
    // If we're updating and the unique slug matches the existing one, return it
    if (existingSlug && existingSlug === uniqueSlug) {
      return existingSlug;
    }
    
    if (!exists) {
      return uniqueSlug;
    }
    
    counter++;
  }
}

/**
 * Validate a slug format
 * Rules:
 * - lowercase only
 * - alphanumeric and hyphens only
 * - no spaces
 * - 3-100 characters
 * 
 * @param {string} slug - The slug to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return false;
  }
  
  const slugRegex = /^[a-z0-9-]{3,100}$/;
  return slugRegex.test(slug) && !slug.startsWith('-') && !slug.endsWith('-') && !slug.includes('--');
}
