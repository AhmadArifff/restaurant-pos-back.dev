const router = require('express').Router();
const c = require('../controllers/discountController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.post('/preview', c.preview);
router.post('/review-voucher/validate', c.validateReviewVoucher);
router.get('/active', c.active);
router.get('/', authenticate, isAdmin, c.list);
router.post('/', authenticate, isAdmin, c.create);
router.put('/:id', authenticate, isAdmin, c.update);
router.delete('/:id', authenticate, isAdmin, c.remove);

module.exports = router;
