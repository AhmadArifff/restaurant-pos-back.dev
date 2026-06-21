const router = require('express').Router();
const controller = require('../controllers/cronController');

router.get('/attendance-start', controller.createAttendanceKeepalive);
router.get('/attendance-cleanup', controller.deleteAttendanceKeepalive);

module.exports = router;
