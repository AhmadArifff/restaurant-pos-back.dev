const router = require('express').Router();
const {
  login,
  getMe,
  register,
  getAllUsers,
  getActiveUsers,
  logout,
  getCashierSchedules,
  createCashierSchedule,
  updateCashierSchedule,
  deleteCashierSchedule,
} =
  require('../controllers/authController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.post('/login',    login);
router.post('/logout',   authenticate, logout);
router.get('/me',        authenticate, getMe);
router.post('/register', authenticate, isAdmin, register);
router.get('/users',     authenticate, isAdmin, getAllUsers);
router.get('/active',    authenticate, isAdmin, getActiveUsers);
router.get('/schedules', authenticate, isAdmin, getCashierSchedules);
router.post('/schedules', authenticate, isAdmin, createCashierSchedule);
router.put('/schedules/:id', authenticate, isAdmin, updateCashierSchedule);
router.delete('/schedules/:id', authenticate, isAdmin, deleteCashierSchedule);

module.exports = router;
