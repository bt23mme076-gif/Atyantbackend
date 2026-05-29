// backend/routes/agent.routes.js
const express = require('express');
const router = express.Router();
const { agentTurn } = require('../controllers/agent.controller');
const authOptional = require('../middleware/authOptional'); // your existing optional auth middleware

router.post('/turn', authOptional, agentTurn);

module.exports = router;

// In your main app.js / index.js:
// app.use('/api/agent', require('./routes/agent.routes'));