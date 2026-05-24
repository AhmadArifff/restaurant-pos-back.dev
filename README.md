# Restaurant POS Backend

Backend REST API untuk aplikasi Restaurant POS. Project ini menangani autentikasi, produk, kategori, transaksi POS, stok bahan baku, main stock, pengajuan stok kasir, laporan bisnis, settings website, upload asset, attendance, dan AI assistant berbasis OpenRouter.

## Tech Stack

- Node.js
- Express 5
- MySQL dengan mysql2/promise
- JWT untuk authentication
- bcryptjs untuk password hashing
- multer untuk upload gambar dan asset settings
- express-validator untuk validasi request
- cors untuk akses frontend
- dotenv untuk environment configuration
- pdfkit untuk export laporan PDF
- axios untuk integrasi AI/OpenRouter
- nodemon untuk development server

## Fitur Utama

### Authentication dan User

- Login admin/kasir.
- Logout dan get current user.
- Register user oleh admin.
- List semua user dan user aktif.
- Middleware authentication dan role admin.

### Produk dan Kategori

- CRUD produk dengan upload gambar.
- CRUD kategori.
- Stock per kasir dan stock semua user.
- Relasi produk dengan bahan baku untuk perhitungan pemakaian stok.

### Transaksi POS

- Create transaksi.
- Get semua transaksi.
- Get detail transaksi dan item transaksi.
- Integrasi transaction service untuk update stok dan financial calculation.

### Stock Items atau Bahan Baku

- CRUD bahan baku.
- Unit bahan baku.
- Stok masuk bahan baku.
- Histori pergerakan stok.
- Harga/HPP bahan untuk margin dan profit report.

### Main Stock

- Summary stok utama.
- Data harian dan bulanan.
- Pembelian stok.
- Update dan delete pembelian stok.
- Manual stock out.
- Recalculate balance semua item atau per item.
- Audit transaksi stok.

### Stock Request

- Kasir submit pengajuan stok.
- Kasir melihat pengajuan sendiri.
- Admin melihat semua request.
- Admin approve request dengan catatan.
- Kasir resubmit request.
- Delete request.
- Audit trail request.

### Attendance dan Staff Performance

- Weekly attendance.
- Staff performance.
- Perhitungan jam kerja dengan proteksi agar sesi lama tanpa logout tidak menghasilkan jam kerja tidak realistis.

### Reports dan Business Analysis

- Statistik hari ini.
- Sales report by range.
- Yearly stats.
- Best selling product.
- Low stock report.
- Transaction years.
- Sales by product.
- Business analysis untuk dashboard laporan.
- Export PDF business analysis profesional dengan chart 7 hari, 30 hari, dan 12 bulan.
- Insight omzet, margin, HPP, profit, payment mix, produk, stok, dan performa karyawan.

### Website Settings

- Public endpoint untuk mengambil settings landing page dan branding.
- Admin endpoint untuk update setting tunggal, bulk update, dan upload file.
- Digunakan frontend untuk landing page settings, login page settings, logo, favicon, dan konfigurasi tampilan.

### AI Assistant

- Endpoint health check AI.
- Endpoint daftar model AI.
- Endpoint query chat AI.
- Session management untuk percakapan.
- Data service internal untuk mengambil context bisnis.
- Integrasi OpenRouter dengan API key dari environment.

## Struktur Folder Penting

```text
src/index.js                 Entry point Express server
src/config/db.js             Koneksi MySQL pool
src/controllers/             Business logic per module
src/routes/                  Route REST API per module
src/middleware/              Auth, upload, settings upload
src/migrations/              Migration database berurutan
src/services/                Service transaksi dan OpenRouter AI
public/images/               Asset upload yang diserve sebagai /images
```

## Persiapan Environment

Buat file `.env` di root backend.

```env
PORT=5000
NODE_ENV=development

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=password_database
DB_NAME=kebab_pos

JWT_SECRET=ubah_dengan_secret_yang_kuat
JWT_EXPIRES=7d

OPENROUTER_API_KEY=
OPENROUTER_MODEL=
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_SITE_NAME=Kebab POS System
```

Catatan:

- `OPENROUTER_API_KEY` diperlukan jika ingin memakai AI assistant.
- `OPENROUTER_MODEL` opsional. Jika kosong, sistem memakai model rekomendasi dari service.
- Jangan commit file `.env`.

## Cara Install dan Menjalankan

Install dependency:

```bash
npm install
```

Jalankan migration database:

```bash
npm run migrate
```

Jalankan server development:

```bash
npm run dev
```

Jalankan server production/local start:

```bash
npm run start
```

Server default berjalan di:

```text
http://localhost:5000
```

API base URL:

```text
http://localhost:5000/api
```

## Migration Database

Migration berada di `src/migrations` dan dijalankan oleh `src/migrate.js`.

Migration yang tersedia:

- users
- categories
- products
- transactions
- transaction_items
- stock_movements
- stock_items
- product_ingredients
- attendance
- main_stock
- website_settings
- stock request approval notes
- stock request audit

Command migration:

```bash
npm run migrate
```

Reset database dari awal:

```bash
npm run migrate:fresh
```

Peringatan: `migrate:fresh` menghapus database lama dan membuat ulang dari awal. Gunakan hanya untuk development atau ketika data boleh dihapus.

## Workflow Sistem

1. Backend dinyalakan dan terkoneksi ke MySQL.
2. Migration membuat tabel dan struktur awal.
3. Frontend login melalui `/api/auth/login`.
4. Backend mengembalikan JWT dan data user.
5. Frontend mengirim token pada setiap request protected.
6. Admin mengelola produk, kategori, stock items, main stock, user, settings, dan laporan.
7. Kasir membuat transaksi POS.
8. Transaction service mencatat transaksi dan menghitung dampak stok.
9. Kasir dapat membuat stock request.
10. Admin melakukan approval stock request.
11. Laporan bisnis membaca transaksi, stok, margin, attendance, dan menghasilkan insight serta PDF.
12. AI assistant mengambil context bisnis dari service internal lalu mengirim prompt ke OpenRouter.

## Endpoint Utama

### Auth

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/register`
- `GET /api/auth/users`
- `GET /api/auth/active`

### Products dan Categories

- `GET /api/products`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `GET /api/products/my-stock`
- `GET /api/products/stock-all`
- `GET /api/products/stock-by-kasir`
- `GET /api/categories`
- `POST /api/categories`
- `DELETE /api/categories/:id`

### Transactions

- `POST /api/transactions`
- `GET /api/transactions`
- `GET /api/transactions/:id`

### Stock Items

- `GET /api/stock-items`
- `POST /api/stock-items`
- `PUT /api/stock-items/:id`
- `DELETE /api/stock-items/:id`
- `POST /api/stock-items/in`
- `GET /api/stock-items/history`
- `GET /api/stock-items/units`

### Main Stock

- `GET /api/main-stock/summary`
- `GET /api/main-stock/daily`
- `GET /api/main-stock/monthly`
- `POST /api/main-stock/out`
- `POST /api/main-stock/purchase`
- `PUT /api/main-stock/purchase/:id`
- `DELETE /api/main-stock/purchase/:id`
- `POST /api/main-stock/recalculate-all`
- `POST /api/main-stock/:itemId/recalculate`

### Stock Requests

- `POST /api/stock-requests`
- `DELETE /api/stock-requests/:id`
- `GET /api/stock-requests`
- `GET /api/stock-requests/my`
- `PUT /api/stock-requests/:id/approve`
- `PUT /api/stock-requests/:id/resubmit`

### Reports

- `GET /api/reports/today`
- `GET /api/reports/sales`
- `GET /api/reports/yearly`
- `GET /api/reports/best-selling`
- `GET /api/reports/stock-low`
- `GET /api/reports/years`
- `GET /api/reports/sales-by-product`
- `GET /api/reports/business-analysis`
- `GET /api/reports/business-analysis/pdf`

### Attendance

- `GET /api/attendance/weekly`
- `GET /api/attendance/performance`

### Settings

- `GET /api/settings`
- `GET /api/settings/:key`
- `PUT /api/settings`
- `PUT /api/settings/bulk-update`
- `PUT /api/settings/upload`

### AI

- `GET /api/ai-chat/health`
- `GET /api/ai-chat/models`
- `POST /api/ai-chat/query`
- `DELETE /api/ai-chat/session/:sessionId`
- `GET /api/ai-chat/sessions`
- `GET /api/ai/data`

## Authentication Rule

Protected endpoints menggunakan header:

```text
Authorization: Bearer <token>
```

Admin-only endpoint memakai middleware `authenticate` dan `isAdmin`.

## Upload dan Static Asset

Backend menyajikan asset upload melalui:

```text
/images
```

Contoh URL:

```text
http://localhost:5000/images/products/nama-file.jpg
```

## Catatan Development

- Pastikan MySQL aktif sebelum menjalankan migration/server.
- Jalankan frontend dengan `NEXT_PUBLIC_API_URL=http://localhost:5000/api`.
- Jangan commit `.env`, secret JWT, atau OpenRouter API key.
- Gunakan `npm run migrate:fresh` hanya jika aman menghapus data lokal.
- Jika menambah tabel baru, buat migration baru dengan nomor urut berikutnya.

## Deployment

1. Siapkan database MySQL production.
2. Set environment variable backend.
3. Jalankan `npm install`.
4. Jalankan `npm run migrate`.
5. Jalankan `npm run start` atau deploy ke platform Node.js.
6. Pastikan folder `public/images` dapat menyimpan file upload atau gunakan storage eksternal jika diperlukan.

## Commit Format

Project ini menggunakan format commit historis seperti:

```text
V.1.1.4 solve menu POS menu riwayat POS and chart analiys
```

Gunakan versi berikutnya dan deskripsi singkat, contoh:

```text
V.1.1.5 add README documentation and improve report ai services
```
