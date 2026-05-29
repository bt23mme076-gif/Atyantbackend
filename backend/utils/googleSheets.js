import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * Helper to get Google credentials.
 * It prioritizes Environment Variables (for Render/Production)
 * and falls back to a JSON file (for Local Development).
 */
function getGoogleAuth() {
  // Check if credentials exist in Environment Variables
  // We removed GOOGLE_PROJECT_ID check because it's optional for Sheets API
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    console.log("✅ Using Environment Variables for Google Auth");
    
    return new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      // Fixes the common newline issue in environment variables
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } 

  // Fallback: Local development using google-key.json
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  // Adjusted path to look for the key in the backend root
  const KEY_PATH = path.join(__dirname, '..', 'google-key.json');

  if (fs.existsSync(KEY_PATH)) {
    console.log("📂 Using google-key.json for Local Auth");
    return new google.auth.JWT({
      keyFile: KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  // If both methods fail, throw a clear error instead of crashing silently
  throw new Error('❌ Google Auth Error: No env vars or google-key.json found.');
}

// Initialize Auth and Sheets instance
const auth = getGoogleAuth();
const sheets = google.sheets({ version: 'v4', auth });

/**
 * Fetches data from a specific Google Sheet.
 * @param {string} campusName - The name of the Tab/Sheet inside your spreadsheet.
 * @param {string} sheetIdKey - The name of the env var containing the Spreadsheet ID.
 */
export const getSheetData = async (campusName, sheetIdKey = 'GOOGLE_SHEET_ID1') => {
  try {
    const spreadsheetId = process.env[sheetIdKey];
    
    if (!spreadsheetId) {
      throw new Error(`Missing required environment variable: ${sheetIdKey}`);
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${campusName}`, // Ensure this matches your Tab name exactly
    });

    return response.data.values;
  } catch (err) {
    console.error(`❌ API Error for ${campusName}:`, err.message);
    return null;
  }
};