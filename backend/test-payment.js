// Test Payment Configuration
import dotenv from 'dotenv';
dotenv.config();

console.log('🧪 Testing Razorpay Configuration\n');

console.log('Environment Variables:');
console.log('RAZORPAY_KEY_ID:', process.env.RAZORPAY_KEY_ID ? '✅ Set' : '❌ Missing');
console.log('RAZORPAY_KEY_SECRET:', process.env.RAZORPAY_KEY_SECRET ? '✅ Set' : '❌ Missing');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? '✅ Set' : '❌ Missing');

console.log('\nRazorpay Details:');
console.log('Key ID:', process.env.RAZORPAY_KEY_ID);
console.log('Key Type:', process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') ? '🔴 LIVE MODE' : '🟡 TEST MODE');

console.log('\n📝 Important Notes:');
console.log('1. For LIVE payments: Use rzp_live_* keys');
console.log('2. For TEST payments: Use rzp_test_* keys');
console.log('3. Test cards will NOT debit money');
console.log('4. Live keys WILL debit real money');

console.log('\n🧪 Test Card Numbers:');
console.log('Card: 4111 1111 1111 1111');
console.log('CVV: Any 3 digits');
console.log('Expiry: Any future date');
console.log('OTP: Will be sent if test mode');

if (process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) {
  console.log('\n⚠️  WARNING: You are using LIVE keys!');
  console.log('⚠️  Real money will be deducted!');
  console.log('⚠️  Switch to TEST keys for testing');
}
