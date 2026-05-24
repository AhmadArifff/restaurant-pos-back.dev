const express = require('express');
const {
  handleAIQuery,
  healthCheck,
  clearSession,
  getActiveSessions,
  getModels,
} = require('../controllers/aiChatController');

const router = express.Router();

router.get('/health', healthCheck);
router.get('/models', getModels);
router.post('/query', handleAIQuery);
router.delete('/session/:sessionId', clearSession);
router.get('/sessions', getActiveSessions);

module.exports = router;