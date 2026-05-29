// routes/resume.js
// Express router — Razorpay order create + verify + Canva link return
//
// npm install razorpay crypto
//
// .env variables needed:
//   RAZORPAY_KEY_ID=rzp_live_xxx
//   RAZORPAY_KEY_SECRET=xxx

import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { optionalAuth } from '../middleware/auth.js';
import User from '../models/User.js';

const router = express.Router();

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Template Data (server side — Canva links NEVER sent to frontend directly)
const TEMPLATES = {
  // SDE / Software Engineering Templates
  1: { 
    name: "SDE Fresher (AI/Data Focus)", 
    price: 6900, 
    canvaLink: "https://canva.link/6gikq57p86xps5x",
    category: "SDE"
  },
  2: { 
    name: "FAANG SDE Fresher (C/C++, DSA)", 
    price: 6900, 
    canvaLink: "https://canva.link/nrixlrpb3d754g0",
    category: "SDE"
  },
  3: { 
    name: "Software Engineer (15+ Years)", 
    price: 6900, 
    canvaLink: "https://canva.link/au7uv1esw0muykt",
    category: "SDE"
  },
  
  // AI/ML Templates
  4: { 
    name: "AI/ML Developer Fresher", 
    price: 6900, 
    canvaLink: "https://canva.link/874swvjik78lpfs",
    category: "AI/ML"
  },
  5: { 
    name: "AI/ML Research", 
    price: 6900, 
    canvaLink: "https://canva.link/o778wru2giyg2lg",
    category: "AI/ML"
  },
  6: { 
    name: "AI/ML FAANG (Deep Learning, NLP, CV)", 
    price: 6900, 
    canvaLink: "https://canva.link/w4w810zi5imswfr",
    category: "AI/ML"
  },
  
  // Core Engineering Templates
  7: { 
    name: "Metallurgical/Materials Engineering", 
    price: 6900, 
    canvaLink: "https://canva.link/gaq7800siqhzh5e",
    category: "Core Engineering"
  },
  8: { 
    name: "Electrical Engineering (Power Systems)", 
    price: 6900, 
    canvaLink: "https://canva.link/35b4044nka71kct",
    category: "Core Engineering"
  },
  9: { 
    name: "Chemical Engineering", 
    price: 6900, 
    canvaLink: "https://canva.link/8sbcpbxaqgayu0z",
    category: "Core Engineering"
  },
  
  // Data Analytics Templates
  10: { 
    name: "Data Analyst/Science (Finance)", 
    price: 6900, 
    canvaLink: "https://canva.link/3aavor642ic41zo",
    category: "Data"
  },
  11: { 
    name: "Product/Consulting/Data Analytics", 
    price: 6900, 
    canvaLink: "https://canva.link/5hpibnj4pgj8516",
    category: "Data"
  },
  
  // Additional Premium Templates
  12: { 
    name: "Tech Professional", 
    price: 6900, 
    canvaLink: "https://canva.link/zartalfdbrxac9j",
    category: "General"
  },
  13: { 
    name: "Modern Professional", 
    price: 6900, 
    canvaLink: "https://canva.link/ct83y2pg8cn2izv",
    category: "General"
  },
  14: { 
    name: "Executive Professional", 
    price: 6900, 
    canvaLink: "https://canva.link/rb092pzb4es867z",
    category: "General"
  },
};

// ─── POST /api/resume/create-order ───────────────────────────────────────────
// Frontend calls this first to get a Razorpay order ID
router.post("/create-order", async (req, res) => {
  try {
    const { templateId } = req.body;
    const template = TEMPLATES[templateId];

    if (!template) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    const order = await razorpay.orders.create({
      amount:   template.price,   // in paise (69 * 100 = 6900)
      currency: "INR",
      receipt:  `receipt_${templateId}_${Date.now()}`,
      notes: { templateId: String(templateId) },
    });

    res.json({ id: order.id, amount: order.amount, currency: order.currency });

  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// ─── POST /api/resume/verify-payment ─────────────────────────────────────────
// Called after Razorpay checkout succeeds — verifies signature, returns Canva link
router.post("/verify-payment", optionalAuth, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      templateId,
    } = req.body;

    // 1. Verify Razorpay signature
    const body      = razorpay_order_id + "|" + razorpay_payment_id;
    const expected  = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // 2. Get Canva link for this template
    const template = TEMPLATES[templateId];
    if (!template) {
      return res.status(400).json({ error: "Invalid template ID" });
    }

    // 3. Save purchase for authenticated users (30 days)
    try {
      if (req.user && req.user._id) {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
        await User.findByIdAndUpdate(req.user._id, {
          $push: {
            purchasedTemplates: {
              templateId: Number(templateId),
              paymentId: razorpay_payment_id,
              canvaLink: template.canvaLink,
              expiresAt,
            }
          }
        });
      }
    } catch (saveErr) {
      console.error('Failed to save purchase:', saveErr);
    }

    // 4. Return Canva link — only after verified payment
    res.json({ success: true, canvaLink: template.canvaLink });

  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ─── GET /api/resume/purchase-status?templateId=1 ───────────────────────────
// Returns whether authenticated user owns an active purchase for the template
router.get('/purchase-status', optionalAuth, async (req, res) => {
  try {
    const templateId = Number(req.query.templateId || 0);
    if (!templateId) return res.status(400).json({ error: 'templateId required' });

    if (!req.user || !req.user._id) {
      return res.json({ owned: false });
    }

    const user = await User.findById(req.user._id).lean();
    if (!user) return res.json({ owned: false });

    const now = new Date();
    const found = (user.purchasedTemplates || []).find(p => Number(p.templateId) === templateId && new Date(p.expiresAt) > now);
    if (found) {
      return res.json({ owned: true, canvaLink: found.canvaLink, expiresAt: found.expiresAt });
    }

    return res.json({ owned: false });
  } catch (err) {
    console.error('purchase-status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/resume/templates ───────────────────────────────────────────────
// Returns all available templates (without Canva links)
router.get('/templates', (req, res) => {
  try {
    const templates = Object.entries(TEMPLATES).map(([id, data]) => ({
      id: Number(id),
      name: data.name,
      price: data.price,
      category: data.category
    }));
    
    res.json({ templates });
  } catch (err) {
    console.error('templates error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;