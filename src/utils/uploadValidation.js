const path = require('path');

const getExtension = (file) => path.extname(file?.originalname || '').toLowerCase().replace('.', '');

const createFileFilter = ({ allowedExtensions, allowedMimeTypes, message }) => (req, file, cb) => {
  const ext = getExtension(file);
  const mime = String(file?.mimetype || '').toLowerCase();
  const isAllowedExtension = allowedExtensions.includes(ext);
  const isAllowedMime = allowedMimeTypes.includes(mime);

  if (isAllowedExtension && isAllowedMime) {
    cb(null, true);
    return;
  }

  const err = new Error(message);
  err.statusCode = 400;
  cb(err, false);
};

module.exports = {
  createFileFilter,
};
