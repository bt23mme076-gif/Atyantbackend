import fetch from 'node-fetch';

const listModels = async () => {
  const apiKey = process.env.GEMINI_API_KEY; // Ensure your API key is set in .env
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    console.log('Available Models:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error fetching model list:', error.message);
  }
};

listModels();