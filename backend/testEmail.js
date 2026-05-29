import dotenv from 'dotenv';
dotenv.config();

import { Resend } from 'resend';

console.log('🧪 Testing Email Notifications...\n');

// Check if API key exists
if (!process.env.RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY not found in .env file');
  process.exit(1);
}

console.log('✅ RESEND_API_KEY found:', process.env.RESEND_API_KEY.substring(0, 10) + '...');

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Test email
async function testEmail() {
  try {
    console.log('\n📧 Sending test email...');
    
    const { data, error } = await resend.emails.send({
      from: 'Atyant <notification@atyant.in>',
      to: ['bt23mme076@students.vnit.ac.in'], // Your email from .env
      subject: '🧪 Test Email from Atyant',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h1 style="color:#10b981;text-align:center">✅ Email Working!</h1>
          <p>This is a test email from Atyant backend.</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
          <p>If you received this, email notifications are working correctly! 🎉</p>
        </div>
      `
    });

    if (error) {
      console.error('❌ Email send failed:', error);
      console.error('\nPossible issues:');
      console.error('1. Invalid API key');
      console.error('2. Domain not verified on Resend');
      console.error('3. Rate limit exceeded');
      console.error('4. Invalid sender email');
      process.exit(1);
    }

    console.log('✅ Email sent successfully!');
    console.log('📧 Email ID:', data.id);
    console.log('\n✅ Check your inbox: bt23mme076@students.vnit.ac.in');
    console.log('📁 Also check spam folder!');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

testEmail();
