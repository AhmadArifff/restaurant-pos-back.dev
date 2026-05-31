const router = require('express').Router();
const c = require('../controllers/customerOrderController');
const { authenticate, isAdmin } = require('../middleware/auth');
const paymentUpload = require('../middleware/paymentUpload');

router.get('/tables', c.listPublicTables);
router.get('/tables/queue', c.getTableQueue);
router.post('/tables/queue', c.joinTableQueue);
router.post('/tables/queue/:queueToken/claim', c.claimTableQueue);
router.get('/tables/manage', authenticate, isAdmin, c.listManagedTables);
router.post('/tables', authenticate, isAdmin, c.createTable);
router.put('/tables/:id', authenticate, isAdmin, c.updateTable);
router.delete('/tables/:id', authenticate, isAdmin, c.deleteTable);
router.post('/tables/session/:sessionToken/release', c.releaseTableSession);
router.post('/tables/:token/session', c.createOrRenewTableSession);
router.get('/tables/:token', c.getPublicTableByToken);

router.get('/menu', c.getPublicMenu);
router.post('/orders', c.createOrder);
router.get('/orders/:orderCode', c.getOrderByCode);
router.post('/orders/:orderCode/payment-proof', paymentUpload.single('proof'), c.submitPaymentProof);
router.post('/orders/:orderCode/review', c.submitReview);
router.post('/orders/:orderCode/review-skip', c.skipReview);

router.get('/orders', authenticate, c.listOrders);
router.put('/orders/:id/status', authenticate, c.updateOrderStatus);

module.exports = router;
