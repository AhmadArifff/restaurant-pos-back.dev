require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });
require('dotenv').config({ path: '.env.migration.local', override: false });

const fs = require('fs/promises');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'restaurant-pos-assets';
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
const shouldUpdateDb = process.argv.includes('--update-db');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const databaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

if (!supabaseUrl || !serviceKey) {
  console.error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.');
  process.exit(1);
}

if (shouldUpdateDb && !databaseUrl) {
  console.error('DATABASE_URL/SUPABASE_DATABASE_URL wajib diisi jika memakai --update-db.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const walk = async (dir) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(fullPath) : fullPath;
    }));
    return files.flat();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const contentTypeFor = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
};

const updateDatabaseUrls = async (mapping) => {
  if (!shouldUpdateDb) return;

  const pg = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    for (const [localUrl, publicUrl] of mapping.entries()) {
      await pg.query('update products set image_url = $1 where image_url = $2', [publicUrl, localUrl]);
      await pg.query('update website_settings set setting_value = $1 where setting_value = $2', [publicUrl, localUrl]);
    }
  } finally {
    await pg.end();
  }
};

const uploadAssets = async () => {
  const files = await walk(IMAGES_DIR);
  const mapping = new Map();

  for (const filePath of files) {
    const relativePath = path.relative(IMAGES_DIR, filePath).replace(/\\/g, '/');
    const storagePath = relativePath;
    const fileBuffer = await fs.readFile(filePath);

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: contentTypeFor(filePath),
        cacheControl: '31536000',
        upsert: true,
      });

    if (error) throw error;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    mapping.set(`/images/${relativePath}`, data.publicUrl);
    console.log(`- uploaded /images/${relativePath}`);
  }

  await updateDatabaseUrls(mapping);
  console.log(`\nUpload selesai. ${files.length} asset diproses.`);
  if (shouldUpdateDb) console.log('URL products dan website_settings sudah diarahkan ke Supabase Storage.');
};

uploadAssets().catch((error) => {
  console.error('Upload asset gagal:', error);
  process.exit(1);
});
