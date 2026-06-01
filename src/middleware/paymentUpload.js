const multer = require('multer');
const { createFileFilter } = require('../utils/uploadValidation');

const fileFilter = createFileFilter({
  allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  message: 'Format file tidak didukung. Gunakan JPG, PNG, WEBP, atau PDF.',
});

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});
