const router = require('express').Router();
const c = require('../controllers/aiDataController');

/**
 * Public endpoint untuk AI service meminta data berdasarkan context
 * Tidak memerlukan authentication karena diakses dari backend sendiri
 */
router.get('/data', c.getDataByContext);

module.exports = router;
