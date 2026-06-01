const multer = require('multer');
const { createFileFilter } = require('../utils/uploadValidation');

const fileFilter = createFileFilter({
  allowedExtensions: ['jpg', 'jpeg', 'png', 'webp'],
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  message: 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WEBP.',
});

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
