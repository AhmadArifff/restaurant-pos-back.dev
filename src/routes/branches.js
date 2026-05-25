const router = require('express').Router();
const c = require('../controllers/branchController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.get('/public', c.list);
router.get('/', authenticate, c.list);
router.post('/sync-from-landing', authenticate, isAdmin, c.syncFromLanding);
router.put('/me', authenticate, c.setMyBranch);

module.exports = router;
