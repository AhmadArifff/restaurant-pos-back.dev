const router = require('express').Router();
const c      = require('../controllers/reportController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.get('/today',        authenticate, c.todayStats);
router.get('/sales',        authenticate, isAdmin, c.sales);
router.get('/yearly',       authenticate, isAdmin, c.yearlyStats);
router.get('/best-selling', authenticate, isAdmin, c.bestSelling);
router.get('/stock-low',    authenticate, c.stockLow);
router.get('/years', authenticate, c.getTransactionYears);
router.get('/sales-by-product', authenticate, isAdmin, c.salesByProduct);
router.get('/business-analysis', authenticate, isAdmin, c.businessAnalysis);
router.get('/business-analysis/pdf', authenticate, isAdmin, c.businessAnalysisPdf);

module.exports = router;
