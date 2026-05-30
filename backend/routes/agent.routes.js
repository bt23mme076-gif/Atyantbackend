// backend/routes/agent.routes.js
import express from 'express';
import { agentTurn } from '../controllers/agent.controller.js';
import authOptional from '../middleware/authOptional.js'; // your existing optional auth middleware

const router = express.Router();

router.post('/turn', authOptional, agentTurn);

export default router;

// In your main app.js / index.js:
// app.use('/api/agent', require('./routes/agent.routes'));