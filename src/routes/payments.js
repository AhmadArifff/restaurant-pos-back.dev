const router = require('express').Router();
const c = require('../controllers/paymentController');
const { authenticate, isAdmin } = require('../middleware/auth');
const paymentUpload = require('../middleware/paymentUpload');

router.get('/public', c.listPublicMethods);
router.get('/', authenticate, isAdmin, c.listMethods);
router.post('/', authenticate, isAdmin, paymentUpload.single('qr_image'), c.createMethod);
router.put('/:id', authenticate, isAdmin, paymentUpload.single('qr_image'), c.updateMethod);
router.delete('/:id', authenticate, isAdmin, c.deleteMethod);

module.exports = router;
