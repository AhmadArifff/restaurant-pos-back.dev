const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const {
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
} = require('../services/supabaseStorage');

const ALLOWED_DATA_TYPES = new Set(['string', 'number', 'boolean', 'json']);
const STORAGE_PUBLIC_MARKER = '/storage/v1/object/public/';

const normalizeDataType = (value) => (ALLOWED_DATA_TYPES.has(value) ? value : 'string');
const normalizeSettingValue = (value) => (value == null ? '' : String(value));
const isPostgres = () => Boolean(db.isPostgres);

const safeJsonParse = (value) => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
};

const collectStorageUrls = (value, urls = new Set()) => {
  if (!value) return urls;

  if (typeof value === 'string') {
    if (value.includes(STORAGE_PUBLIC_MARKER)) {
      urls.add(value);
      return urls;
    }

    const parsed = safeJsonParse(value);
    if (parsed) collectStorageUrls(parsed, urls);
    return urls;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectStorageUrls(item, urls));
    return urls;
  }

  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectStorageUrls(item, urls));
  }

  return urls;
};

const getUnusedSettingAssetUrls = async (nextSettingsByKey) => {
  if (!isSupabaseStorageEnabled()) return [];

  const updatedKeys = Object.keys(nextSettingsByKey);
  if (!updatedKeys.length) return [];

  const [rows] = await db.query(
    'SELECT setting_key, setting_value FROM website_settings ORDER BY setting_key',
  );

  const oldUpdatedUrls = new Set();
  const finalReferencedUrls = new Set();

  for (const row of rows || []) {
    const nextValue = Object.prototype.hasOwnProperty.call(nextSettingsByKey, row.setting_key)
      ? nextSettingsByKey[row.setting_key]
      : row.setting_value;

    collectStorageUrls(nextValue, finalReferencedUrls);

    if (Object.prototype.hasOwnProperty.call(nextSettingsByKey, row.setting_key)) {
      collectStorageUrls(row.setting_value, oldUpdatedUrls);
    }
  }

  for (const [settingKey, nextValue] of Object.entries(nextSettingsByKey)) {
    if (!(rows || []).some((row) => row.setting_key === settingKey)) {
      collectStorageUrls(nextValue, finalReferencedUrls);
    }
  }

  return [...oldUpdatedUrls].filter((url) => !finalReferencedUrls.has(url));
};

const deleteSettingAssets = async (urls) => {
  for (const url of urls || []) {
    try {
      await deleteByPublicUrl(url);
    } catch (error) {
      console.log('Warning: Could not delete stale setting asset:', error.message);
    }
  }
};

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
      const safeValue = normalizeSettingValue(setting_value);
      const staleAssetUrls = await getUnusedSettingAssetUrls({ [setting_key]: safeValue });

      const { safeType } = await upsertSetting({
        settingKey: setting_key,
        settingValue: safeValue,
        dataType: data_type,
        updatedBy,
      });
      await deleteSettingAssets(staleAssetUrls);

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

  // Admin: upload reusable website content image without changing a setting row
  uploadAsset: async (req, res) => {
    try {
      const { setting_key } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: 'File gambar diperlukan' });
      }

      const prefix = String(setting_key || 'content_image')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'content_image';

      let fileUrl;
      let filename;

      if (isSupabaseStorageEnabled()) {
        const uploaded = await uploadImageBuffer({
          folder: 'website-content',
          prefix,
          file: req.file,
        });

        fileUrl = uploaded.publicUrl;
        filename = uploaded.objectPath;
      } else {
        const contentDir = path.join(__dirname, '../../public/images/content');
        if (!fs.existsSync(contentDir)) {
          fs.mkdirSync(contentDir, { recursive: true });
        }

        const ext = path.extname(req.file.originalname);
        filename = `${prefix}-${Date.now()}${ext}`;
        const filepath = path.join(contentDir, filename);
        fs.writeFileSync(filepath, req.file.buffer);

        fileUrl = `/images/content/${filename}`;
      }

      res.json({
        message: 'File berhasil diunggah',
        file_url: fileUrl,
        setting_value: fileUrl,
        filename,
      });
    } catch (err) {
      console.error('Error uploading content asset:', err.message);
      res.status(500).json({ error: 'Gagal mengunggah file' });
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
      const nextSettingsByKey = {};

      for (const setting of settings) {
        const {
          setting_key,
          setting_value,
          data_type = 'string',
        } = setting || {};

        if (!setting_key) continue;
        nextSettingsByKey[setting_key] = normalizeSettingValue(setting_value);
      }

      const staleAssetUrls = await getUnusedSettingAssetUrls(nextSettingsByKey);

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

      await deleteSettingAssets(staleAssetUrls);

      res.json({ message: 'Semua setting berhasil disimpan' });
    } catch (err) {
      console.error('Error bulk updating settings:', err.message);
      res.status(500).json({ error: 'Gagal menyimpan settings', details: err.message });
    }
  },
};
