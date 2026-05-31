const router = require('express').Router();
const settingsController = require('../controllers/settingsController');
const { authenticate, isAdmin } = require('../middleware/auth');
const settingsUpload = require('../middleware/settingsUpload');

// Admin routes - HARUS DI ATAS agar tidak tertangkap :key parameter
router.put('/bulk-update', authenticate, isAdmin, settingsController.bulkUpdate);
router.put('/upload-asset', authenticate, isAdmin, settingsUpload.single('file'), settingsController.uploadAsset);
router.put('/upload', authenticate, isAdmin, settingsUpload.single('file'), settingsController.updateWithFile);
router.put('/', authenticate, isAdmin, settingsController.update);

// Public routes - anyone can get all settings (for landing page, navbar branding)
router.get('/', settingsController.getAll);

// Public route - get specific setting by key (HARUS DI PALING AKHIR)
router.get('/:key', settingsController.getByKey);

module.exports = router;
