const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve gambar produk
app.use('/images', express.static(path.join(process.cwd(), 'public/images')));

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/categories',   require('./routes/categories'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/stock-items',  require('./routes/stockItems'));   // ← bahan baku
app.use('/api/reports',      require('./routes/reports'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/main-stock',     require('./routes/mainStock'));
app.use('/api/stock-requests', require('./routes/stockRequests'));
app.use('/api/settings',       require('./routes/settings'));       // ← website settings
app.use('/api/ai-chat',        require('./routes/aiChat'));          // ← AI Chat dengan OpenRouter
app.use('/api/ai',             require('./routes/aiData'));          // ← AI Data Service

app.use((req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

app.get('/', (req, res) => res.json({ message: 'Kebab POS API Running' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Urutan testing di Postman / Thunder Client
// 1. POST   /api/auth/login              → dapat token
// 2. GET    /api/products                → list produk (pakai Bearer token)
// 3. POST   /api/products                → tambah produk
// 4. POST   /api/stock/in               → tambah stok produk
// 5. POST   /api/transactions           → buat transaksi, cek stok berkurang
// 6. GET    /api/transactions/:id       → lihat detail + items
// 7. GET    /api/reports/sales          → laporan penjualan
// 8. GET    /api/reports/best-selling   → produk terlaris