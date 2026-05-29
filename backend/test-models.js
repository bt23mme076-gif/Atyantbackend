import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  try {
    console.log('🔍 Checking available Gemini models...\n');
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    
    if (!response.ok) {
      console.error('❌ Error:', response.status, response.statusText);
      return;
    }
    
    const data = await response.json();
    
    console.log('📋 Available Models:\n');
    data.models.forEach(model => {
      if (model.supportedGenerationMethods?.includes('generateContent')) {
        console.log(`✅ ${model.name}`);
        console.log(`   Display Name: ${model.displayName}`);
        console.log(`   Version: ${model.version}`);
        console.log('');
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

listModels();