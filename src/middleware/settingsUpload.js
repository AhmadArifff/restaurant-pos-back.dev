const multer = require('multer');
const { createFileFilter } = require('../utils/uploadValidation');

const fileFilter = createFileFilter({
  allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'ico'],
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'],
  message: 'Format gambar tidak didukung. Gunakan JPG, PNG, WEBP, GIF, atau ICO.',
});

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
