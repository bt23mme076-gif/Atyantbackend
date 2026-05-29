# Razorpay Payment Integration - Setup Guide

## ✅ Implementation Complete

### Features Implemented:
1. **3 Mentorship Options**:
   - 💬 Chat Session: 19
   - 🎥 Video Call: ₹999
   - 📚 Complete Roadmap: ₹1,499

2. **Payment Flow**:
   - User clicks "Book Now" → Razorpay payment page opens
   - Payment includes questionId, userId, mentorshipType in metadata
   - Webhook receives payment confirmation
   - Database stores payment record
   - Answer Card shows "Payment Confirmed" banner

3. **Payment Tracking**:
   - Payment model stores all transaction data
   - Question model updated with payment status
   - Users can view payment history
   - Mentors can view earnings

---

## 🔧 Razorpay Dashboard Setup

### Step 1: Create Payment Link

1. Login to [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Go to **Payment Pages** → **Payment Links**
3. Click **Create Payment Link**
4. Configure:
   - **Title**: "Atyant Mentorship"
   - **Description**: "Get personalized guidance from expert mentors"
   - **Enable Custom Amount**: ✅ YES (Important!)
   - **Minimum Amount**: 499 (in rupees)
   - **Currency**: INR

5. **Add Custom Fields** (Important for tracking):
   - Field 1: `questionId` (Text, Required)
   - Field 2: `userId` (Text, Required)
   - Field 3: `mentorshipType` (Text, Required)

6. Click **Create Link**
7. **Copy the Payment Link URL** (e.g., `https://pages.razorpay.com/pl_XXXXXXXX/view`)

---

### Step 2: Update Frontend Code

Replace the Razorpay link in:
```javascript
// frontend/src/components/AnswerCard.jsx
const mentorshipOptions = {
  chat: {
    razorpayLink: 'YOUR_RAZORPAY_LINK_HERE', // Paste your link
    // ... rest stays same
  },
  // Same for video and roadmap
};
```

---

### Step 3: Setup Webhook

1. In Razorpay Dashboard, go to **Settings** → **Webhooks**
2. Click **Create New Webhook**
3. Configure:
   - **Webhook URL**: `https://your-domain.com/api/payments/webhook`
   - **Active Events**: Select these:
     - ✅ `payment.captured`
     - ✅ `payment.failed`
   - **Secret**: Generate a strong secret (save it!)

4. Click **Create Webhook**

---

### Step 4: Update Environment Variables

Add to your `.env` file:

```env
# Razorpay Credentials
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXX
RAZORPAY_KEY_SECRET=YYYYYYYYYYYYYYYY
RAZORPAY_WEBHOOK_SECRET=whsec_ZZZZZZZZZZ
```

**Get these from**:
- **Key ID & Secret**: Dashboard → Settings → API Keys
- **Webhook Secret**: From Step 3 above

---

## 🧪 Testing the Integration

### Test Payment Flow:

1. **Start Backend**:
   ```bash
   cd backend
   npm start
   ```

2. **Start Frontend**:
   ```bash
   cd frontend
   npm run dev
   ```

3. **Test Steps**:
   - Submit a question as a student
   - Wait for answer card to appear
   - Click "Book Now" on any mentorship option
   - Complete payment using test card:
     - **Card**: 4111 1111 1111 1111
     - **CVV**: 123
     - **Expiry**: Any future date
   - Check database for Payment record
   - Refresh answer card - should show "Payment Confirmed" banner

---

## 📊 Database Schema

### Payment Collection:
```javascript
{
  razorpayPaymentId: "pay_XXXXXXXX",
  questionId: ObjectId("..."),
  userId: ObjectId("..."),
  mentorId: ObjectId("..."),
  mentorshipType: "video", // chat, video, roadmap
  amount: 999,
  currency: "INR",
  status: "captured",
  createdAt: ISODate("...")
}
```

### Question Collection (Updated):
```javascript
{
  // ...existing fields...
  isPaid: true,
  paidMentorshipType: "video",
  paidAt: ISODate("...")
}
```

---

## 🔍 Monitoring Payments

### Check Payment Status:
```bash
# Get payment status for a question
GET /api/payments/status/:questionId
Authorization: Bearer <token>
```

### View User Payments:
```bash
# Get all payments by logged-in user
GET /api/payments/my-payments
Authorization: Bearer <token>
```

### View Mentor Earnings:
```bash
# Get earnings for logged-in mentor
GET /api/payments/mentor-earnings
Authorization: Bearer <token>
```

---

## 🚨 Webhook Verification

The webhook endpoint verifies Razorpay signatures to prevent fraud:

```javascript
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const shasum = crypto.createHmac('sha256', secret);
shasum.update(JSON.stringify(req.body));
const digest = shasum.digest('hex');

if (digest !== req.headers['x-razorpay-signature']) {
  // Invalid signature - reject
}
```

---

## ✅ Checklist

- [ ] Created Payment Link in Razorpay Dashboard
- [ ] Copied Payment Link URL to frontend code
- [ ] Setup Webhook in Razorpay Dashboard
- [ ] Added environment variables to `.env`
- [ ] Tested payment flow with test card
- [ ] Verified payment record in database
- [ ] Confirmed "Payment Confirmed" banner appears

---

## 🎯 Next Steps

1. **Deploy to Production**:
   - Update webhook URL to production domain
   - Switch to live Razorpay keys
   - Test with small real payment

2. **Add Features**:
   - Email notifications after payment
   - WhatsApp integration for session scheduling
   - Video call scheduling interface
   - Payment refund functionality

3. **Monitor**:
   - Check Razorpay dashboard daily
   - Monitor webhook logs
   - Track conversion rates

---

## 📞 Support

If you encounter issues:
1. Check Razorpay webhook logs in dashboard
2. Check backend server logs for webhook errors
3. Verify environment variables are set correctly
4. Contact Razorpay support for payment issues

---

**Razorpay Payment Integration Complete! 🎉**
