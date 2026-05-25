const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true,
}));
app.use(express.json());

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
app.use('/api/ai-chat', require('./routes/aiChat'));
app.use('/api/ai', require('./routes/aiData'));

app.use((req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
