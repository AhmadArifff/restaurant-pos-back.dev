const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

const normalizeOrigin = (origin) => String(origin || '').replace(/\/+$/, '');
const allowedOrigins = new Set([
  normalizeOrigin(process.env.FRONTEND_URL),
  ...String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean),
  'https://restaurant-pos-dev.vercel.app',
  'https://restaurant-pos.dev.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (req, res) => res.json({ message: 'Kebab POS API Running' }));

// Serve local images for development/local storage mode.
app.use('/images', express.static(path.join(process.cwd(), 'public/images')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/stock-items', require('./routes/stockItems'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/main-stock', require('./routes/mainStock'));
app.use('/api/stock-requests', require('./routes/stockRequests'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/ai-chat', require('./routes/aiChat'));
app.use('/api/ai', require('./routes/aiData'));
app.use('/api/customer', require('./routes/customerOrders'));
app.use('/api/cron', require('./routes/cron'));

app.use((req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Ukuran file terlalu besar. Maksimal upload gambar 10MB.' });
  }

  if (err?.statusCode === 400) {
    return res.status(400).json({ message: err.message || 'File upload tidak valid.' });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Ukuran data terlalu besar. Unggah gambar sebagai file lalu simpan kembali.' });
  }

  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
