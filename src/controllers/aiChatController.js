const {
  sendAIQuery,
  checkAIChatHealth,
  clearSessionTokens,
  getActiveSessions,
  getAvailableChatModels,
} = require('../services/openrouterAI');

/**
 * POST /api/ai-chat/query
 */
exports.handleAIQuery = async (req, res) => {
  try {
    const {
      message,
      conversationHistory = [],
      sessionId = `default-${req.ip}`,
      modelId,
      maxTokens,
    } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Pesan tidak boleh kosong',
        message: 'Silakan masukkan pertanyaan Anda.',
      });
    }

    if (message.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Pesan terlalu panjang',
        message: 'Pesan maksimal 500 karakter.',
      });
    }

    const result = await sendAIQuery(message, conversationHistory, sessionId, {
      modelId,
      maxTokens,
    });

    if (!result.success) {
      return res.status(200).json({
        success: false,
        response: null,
        error: result.error,
        message: result.message,
        tokenUsage: result.tokenUsage,
        selectedModel: result.selectedModel || modelId || null,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      response: result.response,
      message: result.message,
      tokenUsage: result.tokenUsage,
      usage: result.usage,
      selectedModel: result.selectedModel,
      resolvedModel: result.modelResolvedByOpenRouter,
      sessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('AI Chat Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Terjadi error pada server. Silakan coba lagi nanti.',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/ai-chat/models
 */
exports.getModels = async (_req, res) => {
  try {
    const models = getAvailableChatModels();
    return res.status(200).json({
      success: true,
      models,
      recommendedModel: models.find((m) => m.recommended)?.id || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil daftar model AI.',
      error: error.message,
    });
  }
};

/**
 * GET /api/ai-chat/health
 */
exports.healthCheck = async (_req, res) => {
  try {
    const health = await checkAIChatHealth();
    const statusCode = health.connected ? 200 : 503;
    return res.status(statusCode).json(health);
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      connected: false,
      error: error.message,
    });
  }
};

/**
 * DELETE /api/ai-chat/session/:sessionId
 */
exports.clearSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = clearSessionTokens(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus session',
      error: error.message,
    });
  }
};

/**
 * GET /api/ai-chat/sessions
 */
exports.getActiveSessions = async (_req, res) => {
  try {
    const sessions = getActiveSessions();
    return res.status(200).json({
      success: true,
      count: sessions.length,
      sessions,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data sessions',
      error: error.message,
    });
  }
};
