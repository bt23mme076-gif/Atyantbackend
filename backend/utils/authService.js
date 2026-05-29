import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Load client secrets from a local file
const loadCredentials = () => {
  try {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    return JSON.parse(content);
  } catch (err) {
    console.error('Error loading client secret file:', err);
    throw err;
  }
};

// Authorize a client with credentials
const authorize = async () => {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we have previously stored a token
  try {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
  } catch (err) {
    console.log('Token not found. Please authenticate.');
    return getNewToken(oAuth2Client);
  }

  return oAuth2Client;
};

// Get and store new token
const getNewToken = (oAuth2Client) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
};

export { authorize, getNewToken };