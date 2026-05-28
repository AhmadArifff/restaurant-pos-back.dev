const router = require('express').Router();
const c = require('../controllers/transactionController');
const { authenticate } = require('../middleware/auth');

router.post('/',    authenticate, c.create);
router.get('/',     authenticate, c.getAll);
router.get('/:id',  authenticate, c.getById);
router.delete('/:id', authenticate, c.delete);

module.exports = router;
