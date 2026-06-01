const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { isSupabaseStorageEnabled } = require('../services/supabaseStorage');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'public/images/products');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `product-${Date.now()}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Format gambar tidak didukung'), false);
};

module.exports = multer({
  storage: (process.env.VERCEL || isSupabaseStorageEnabled()) ? multer.memoryStorage() : storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
