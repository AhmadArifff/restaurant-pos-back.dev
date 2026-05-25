const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const {
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
} = require('../services/supabaseStorage');

const ALLOWED_DATA_TYPES = new Set(['string', 'number', 'boolean', 'json']);

const normalizeDataType = (value) => (ALLOWED_DATA_TYPES.has(value) ? value : 'string');
const normalizeSettingValue = (value) => (value == null ? '' : String(value));
const isPostgres = () => Boolean(db.isPostgres);

const upsertSetting = async ({ settingKey, settingValue, dataType = 'string', updatedBy }) => {
  const safeType = normalizeDataType(dataType);
  const safeValue = normalizeSettingValue(settingValue);

  if (isPostgres()) {
    await db.query(
      `INSERT INTO website_settings (setting_key, setting_value, data_type, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         data_type = EXCLUDED.data_type,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [settingKey, safeValue, safeType, updatedBy],
    );
    return { safeType, safeValue };
  }

  await db.query(
    `INSERT INTO website_settings (setting_key, setting_value, data_type, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       setting_value = VALUES(setting_value),
       data_type = VALUES(data_type),
       updated_by = VALUES(updated_by)`,
    [settingKey, safeValue, safeType, updatedBy],
  );
  return { safeType, safeValue };
};

// Ensure table exists and stays aligned with migration 015 schema
const ensureTableExists = async () => {
  try {
    if (isPostgres()) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS website_settings (
          id BIGSERIAL PRIMARY KEY,
          setting_key VARCHAR(100) UNIQUE NOT NULL,
          setting_value TEXT NOT NULL,
          data_type VARCHAR(20) NOT NULL DEFAULT 'string'
            CHECK (data_type IN ('string', 'number', 'boolean', 'json')),
          updated_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_website_settings_setting_key ON website_settings(setting_key)');
      return;
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS website_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value LONGTEXT NOT NULL,
        data_type ENUM('string','number','boolean','json') DEFAULT 'string',
        updated_by INT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_setting_key (setting_key)
      )
    `);

    // Keep older deployments consistent with latest schema
    await db.query(`
      ALTER TABLE website_settings
      MODIFY setting_value LONGTEXT NOT NULL,
      MODIFY data_type ENUM('string','number','boolean','json') DEFAULT 'string'
    `);

    console.log('website_settings table ready');
  } catch (error) {
    console.error('Error creating website_settings table:', error.message);
    throw error;
  }
};

ensureTableExists().catch((err) => {
  console.error('Failed to initialize settings table:', err);
});

module.exports = {
  // Public: get all settings
  getAll: async (req, res) => {
    try {
      await ensureTableExists();
      const [rows] = await db.query(
        'SELECT setting_key, setting_value FROM website_settings ORDER BY setting_key',
      );

      const settings = {};
      if (Array.isArray(rows)) {
        rows.forEach((row) => {
          settings[row.setting_key] = row.setting_value;
        });
      }

      res.json(settings);
    } catch (err) {
      console.error('Error fetching settings:', err.message);
      res.status(500).json({ error: 'Gagal mengambil settings', details: err.message });
    }
  },

  // Public: get setting by key
  getByKey: async (req, res) => {
    try {
      await ensureTableExists();
      const { key } = req.params;
      const [rows] = await db.query(
        'SELECT setting_value FROM website_settings WHERE setting_key = ?',
        [key],
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.json({ value: null });
      }

      res.json({ value: rows[0].setting_value });
    } catch (err) {
      console.error('Error fetching setting by key:', err.message);
      res.status(500).json({ error: 'Gagal mengambil setting', details: err.message });
    }
  },

  // Admin: update single setting
  update: async (req, res) => {
    try {
      await ensureTableExists();
      const {
        setting_key,
        setting_value,
        data_type = 'string',
      } = req.body;

      if (!setting_key) {
        return res.status(400).json({ error: 'setting_key diperlukan' });
      }

      const updatedBy = req.user?.id || 1;

      const { safeType, safeValue } = await upsertSetting({
        settingKey: setting_key,
        settingValue: setting_value,
        dataType: data_type,
        updatedBy,
      });

      res.json({
        message: 'Setting berhasil disimpan',
        setting_key,
        setting_value: safeValue,
        data_type: safeType,
      });
    } catch (err) {
      console.error('Error updating setting:', err.message);
      res.status(500).json({ error: 'Gagal menyimpan setting', details: err.message });
    }
  },

  // Admin: upload and save image setting
  updateWithFile: async (req, res) => {
    try {
      await ensureTableExists();
      const { setting_key } = req.body;

      if (!setting_key || !req.file) {
        return res.status(400).json({ error: 'setting_key dan file diperlukan' });
      }

      const [oldRows] = await db.query(
        'SELECT setting_value FROM website_settings WHERE setting_key = ?',
        [setting_key],
      );

      let settingValue;
      let filename;

      if (isSupabaseStorageEnabled()) {
        if (Array.isArray(oldRows) && oldRows.length > 0) {
          await deleteByPublicUrl(oldRows[0].setting_value);
        }

        const uploaded = await uploadImageBuffer({
          folder: 'branding',
          prefix: setting_key,
          file: req.file,
        });

        settingValue = uploaded.publicUrl;
        filename = uploaded.objectPath;
      } else {
        const brandingDir = path.join(__dirname, '../../public/images/branding');
        if (!fs.existsSync(brandingDir)) {
          fs.mkdirSync(brandingDir, { recursive: true });
        }

        const ext = path.extname(req.file.originalname);
        filename = `${setting_key}-${Date.now()}${ext}`;
        const filepath = path.join(brandingDir, filename);
        fs.writeFileSync(filepath, req.file.buffer);

        settingValue = `/images/branding/${filename}`;
      }

      if (Array.isArray(oldRows) && oldRows.length > 0 && oldRows[0].setting_value) {
        const oldPath = oldRows[0].setting_value;
        if (oldPath.includes('/images/branding/')) {
          const safeOldPath = oldPath.replace(/^\/+/, '');
          const fullOldPath = path.join(__dirname, '../../public', safeOldPath);
          try {
            if (fs.existsSync(fullOldPath)) {
              fs.unlinkSync(fullOldPath);
            }
          } catch (e) {
            console.log('Warning: Could not delete old file:', e.message);
          }
        }
      }

      const updatedBy = req.user?.id || 1;

      await upsertSetting({
        settingKey: setting_key,
        settingValue,
        dataType: 'string',
        updatedBy,
      });

      res.json({
        message: 'File berhasil diunggah',
        setting_key,
        setting_value: settingValue,
        file_url: settingValue,
        filename,
      });
    } catch (err) {
      console.error('Error uploading file:', err.message);
      res.status(500).json({ error: 'Gagal mengunggah file', details: err.message });
    }
  },

  // Admin: bulk update settings
  bulkUpdate: async (req, res) => {
    try {
      await ensureTableExists();
      const settings = Array.isArray(req.body) ? req.body : req.body?.settings;

      if (!Array.isArray(settings)) {
        return res.status(400).json({ error: 'Body harus berupa array settings' });
      }

      const updatedBy = req.user?.id || 1;

      for (const setting of settings) {
        const {
          setting_key,
          setting_value,
          data_type = 'string',
        } = setting || {};

        if (!setting_key) continue;

        await upsertSetting({
          settingKey: setting_key,
          settingValue: setting_value,
          dataType: data_type,
          updatedBy,
        });
      }

      res.json({ message: 'Semua setting berhasil disimpan' });
    } catch (err) {
      console.error('Error bulk updating settings:', err.message);
      res.status(500).json({ error: 'Gagal menyimpan settings', details: err.message });
    }
  },
};
