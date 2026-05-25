# Supabase Deployment Guide

Panduan ini dipakai saat backend Restaurant POS dipindahkan dari MySQL/local image storage ke Supabase Postgres + Supabase Storage untuk deployment Vercel.

## 1. Environment Vercel

Gunakan template berikut:

- Backend: `.env.vercel.example`
- Frontend: `../kebab-pos-client/.env.vercel.example`
- Migrasi lokal: `.env.migration.example`

Jangan commit value asli untuk database password, service role key, JWT secret, atau OpenRouter key.

## 2. Buat Schema Database

Buka Supabase Dashboard > SQL Editor, lalu jalankan:

1. `supabase/schema.sql`
2. `supabase/storage.sql`

`schema.sql` membuat tabel PostgreSQL untuk seluruh modul POS.
`storage.sql` membuat bucket public `restaurant-pos-assets` untuk asset image.

## 3. Migrasi Data dari MySQL ke Supabase

Pastikan `.env` lokal atau `.env.migration.local` berisi koneksi MySQL lama dan `SUPABASE_DATABASE_URL`.

Jalankan:

```bash
npm run migrate:supabase
```

Script akan memindahkan data tabel utama dengan urutan foreign key yang aman dan menjaga nilai `id` lama.

## 4. Upload Asset Lama ke Supabase Storage

Upload semua file dari `public/images` ke bucket Supabase:

```bash
npm run storage:supabase
```

Jika ingin sekaligus mengubah URL lama `/images/...` di tabel `products` dan `website_settings` menjadi public URL Supabase:

```bash
npm run storage:supabase:update-db
```

## 5. Runtime Storage Baru

Set environment backend:

```env
STORAGE_DRIVER=supabase
SUPABASE_STORAGE_BUCKET=restaurant-pos-assets
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Saat `STORAGE_DRIVER=supabase`, upload produk dan branding/settings akan langsung masuk ke Supabase Storage, lalu database menyimpan public URL image.

## 6. Runtime Database Baru

Set environment backend:

```env
DB_CLIENT=postgres
DATABASE_URL=postgresql://...
```

Backend memiliki adapter PostgreSQL dasar agar pola `db.query(sql, params)` tetap kompatibel. Namun beberapa query lama masih memakai fungsi MySQL seperti `YEAR()` dan `MONTH()` yang ditranslasi otomatis oleh adapter. Setelah deploy, lakukan smoke test menu utama: login, produk, POS, stok, laporan, settings, dan AI assistant.

## 7. Vercel Backend

Backend Express sudah diexport dari `src/index.js`, sehingga deploy di Vercel bisa memakai zero-config tanpa `vercel.json` khusus. Endpoint tetap memakai prefix `/api/...` sesuai route Express.

Smoke test setelah deploy:

```text
GET https://your-backend.vercel.app/
GET https://your-backend.vercel.app/api/settings
POST https://your-backend.vercel.app/api/auth/login
GET https://your-backend.vercel.app/api/ai-chat/models
```

## 9. OpenRouter Free Model Fallback

Untuk Vercel, `OPENROUTER_MODEL` tidak wajib jika Anda memakai fallback chain.

Rekomendasi:

```env
OPENROUTER_MODEL=openrouter/free
OPENROUTER_MODEL_FALLBACKS=qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,meta-llama/llama-3.3-70b-instruct:free,nvidia/nemotron-nano-12b-v2-vl:free,liquid/lfm-2.5-1.2b-thinking:free,liquid/lfm-2.5-1.2b-instruct:free,meta-llama/llama-3.2-3b-instruct:free,nousresearch/hermes-3-llama-3.1-405b:free,qwen/qwen3-coder:free,cognitivecomputations/dolphin-mistral-24b-venice-edition:free
```

Backend akan memakai urutan:

1. Model yang dipilih user dari UI.
2. `OPENROUTER_MODEL`.
3. `OPENROUTER_MODEL_FALLBACKS`.
4. `OPENROUTER_FREE_MODELS` jika diisi.
5. `openrouter/free` dan katalog free bawaan.

Jika satu model terkena rate limit/quota/provider error/timeout, request otomatis dicoba ulang ke model berikutnya.

## 8. Vercel Frontend

Set frontend environment:

```env
NEXT_PUBLIC_API_URL=https://your-backend.vercel.app/api
```

Jika backend menyimpan image Supabase sebagai URL penuh `https://...`, frontend akan langsung menggunakannya tanpa prefix backend.
