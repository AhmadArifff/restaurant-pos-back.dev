const db = require('../config/db');
const {
  ensurePaymentTables,
  getPaymentMethodById,
  listPaymentMethods,
  normalizePaymentPayload,
  removePaymentAsset,
  uploadPaymentAsset,
} = require('../services/paymentService');

const sendSafeError = (res, status, message) => res.status(status).json({ message });

exports.listPublicMethods = async (req, res) => {
  try {
    const rows = await listPaymentMethods({ includeInactive: false });
    res.json(rows);
  } catch (_) {
    sendSafeError(res, 500, 'Gagal mengambil metode pembayaran');
  }
};

exports.listMethods = async (req, res) => {
  try {
    const rows = await listPaymentMethods({ includeInactive: true });
    res.json(rows);
  } catch (_) {
    sendSafeError(res, 500, 'Gagal mengambil metode pembayaran');
  }
};

exports.createMethod = async (req, res) => {
  try {
    await ensurePaymentTables();
    const payload = normalizePaymentPayload(req.body);
    const qrImageUrl = req.file
      ? await uploadPaymentAsset({ file: req.file, folder: 'payments', prefix: payload.method_key })
      : null;

    const [result] = await db.query(`
      INSERT INTO payment_methods
        (method_key, name, type, provider_name, account_name, account_number, qr_image_url,
         instructions, payment_timeout_minutes, status, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      payload.method_key,
      payload.name,
      payload.type,
      payload.provider_name,
      payload.account_name,
      payload.account_number,
      qrImageUrl,
      payload.instructions,
      payload.payment_timeout_minutes,
      payload.status,
      payload.sort_order,
      req.user?.id || null,
    ]);

    const [rows] = await db.query('SELECT * FROM payment_methods WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Metode pembayaran berhasil dibuat', data: rows[0] });
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) {
      return sendSafeError(res, 400, 'Kode metode pembayaran sudah digunakan');
    }
    sendSafeError(res, 500, 'Gagal menyimpan metode pembayaran');
  }
};

exports.updateMethod = async (req, res) => {
  try {
    await ensurePaymentTables();
    const existing = await getPaymentMethodById(req.params.id, { activeOnly: false });
    if (!existing) return sendSafeError(res, 404, 'Metode pembayaran tidak ditemukan');

    const payload = normalizePaymentPayload(req.body);
    let qrImageUrl = existing.qr_image_url || null;
    if (req.file) {
      await removePaymentAsset(qrImageUrl);
      qrImageUrl = await uploadPaymentAsset({ file: req.file, folder: 'payments', prefix: payload.method_key });
    }
    if (String(req.body.remove_qr || '') === '1') {
      await removePaymentAsset(qrImageUrl);
      qrImageUrl = null;
    }

    await db.query(`
      UPDATE payment_methods
      SET method_key = ?,
          name = ?,
          type = ?,
          provider_name = ?,
          account_name = ?,
          account_number = ?,
          qr_image_url = ?,
          instructions = ?,
          payment_timeout_minutes = ?,
          status = ?,
          sort_order = ?
      WHERE id = ?
    `, [
      payload.method_key,
      payload.name,
      payload.type,
      payload.provider_name,
      payload.account_name,
      payload.account_number,
      qrImageUrl,
      payload.instructions,
      payload.payment_timeout_minutes,
      payload.status,
      payload.sort_order,
      req.params.id,
    ]);

    const [rows] = await db.query('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ message: 'Metode pembayaran berhasil diupdate', data: rows[0] });
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) {
      return sendSafeError(res, 400, 'Kode metode pembayaran sudah digunakan');
    }
    sendSafeError(res, 500, 'Gagal mengupdate metode pembayaran');
  }
};

exports.deleteMethod = async (req, res) => {
  try {
    await ensurePaymentTables();
    const existing = await getPaymentMethodById(req.params.id, { activeOnly: false });
    if (!existing) return sendSafeError(res, 404, 'Metode pembayaran tidak ditemukan');

    if (String(req.query.hard || '') === '1') {
      await removePaymentAsset(existing.qr_image_url);
      await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
      return res.json({ message: 'Metode pembayaran berhasil dihapus' });
    }

    await db.query("UPDATE payment_methods SET status = 'inactive' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Metode pembayaran dinonaktifkan' });
  } catch (_) {
    sendSafeError(res, 500, 'Gagal menghapus metode pembayaran');
  }
};
