const {
  createDailyAttendanceKeepalive,
  deleteDailyAttendanceKeepalive,
} = require('../services/attendanceKeepaliveService');

const isAuthorizedCron = (req) => {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  return req.get('authorization') === `Bearer ${secret}`;
};

const runCron = (task) => async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ message: 'Akses otomatisasi ditolak.' });
  }

  try {
    const result = await task();
    return res.json({ ok: true, result });
  } catch (error) {
    console.error('Attendance keepalive cron failed:', error);
    return res.status(500).json({ message: 'Otomatisasi kehadiran belum berhasil dijalankan.' });
  }
};

exports.createAttendanceKeepalive = runCron(createDailyAttendanceKeepalive);
exports.deleteAttendanceKeepalive = runCron(deleteDailyAttendanceKeepalive);
