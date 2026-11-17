import { google } from 'googleapis';

let sheets = null;

function getSheets() {
  if (sheets) return sheets;
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

// Returns the raw rows of one tab, or null on failure.
export const getSheetData = async (tabName, sheetIdKey = 'GOOGLE_SHEET_ID1') => {
  try {
    const spreadsheetId = process.env[sheetIdKey];
    if (!spreadsheetId) throw new Error(`Missing ${sheetIdKey}`);
    const response = await getSheets().spreadsheets.values.get({ spreadsheetId, range: tabName });
    return response.data.values;
  } catch (err) {
    console.error(`[googleSheets] ${tabName}:`, err.message);
    return null;
  }
};
