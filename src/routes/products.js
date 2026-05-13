const router  = require('express').Router();
const c       = require('../controllers/productController');
const { authenticate, isAdmin } = require('../middleware/auth');
const upload  = require('../middleware/upload');

router.get('/',      authenticate, c.getAll);
router.post('/',     authenticate, isAdmin, upload.single('image'), c.create);
router.put('/:id',   authenticate, isAdmin, upload.single('image'), c.update);
router.delete('/:id',authenticate, isAdmin, c.remove);
router.get('/my-stock', authenticate, c.getMyStock); // kasir
router.get('/stock-all', authenticate, c.getStockAllUsers);
router.get('/stock-by-kasir', authenticate, isAdmin, c.getStockByKasir);

module.exports = router;
