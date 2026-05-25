const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'restaurant-pos-assets';
const PUBLIC_URL = process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL;

const getSupabaseClient = () => {
  if (STORAGE_DRIVER !== 'supabase') return null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi untuk STORAGE_DRIVER=supabase');
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};

const sanitizeName = (value) =>
  String(value || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const isSupabaseStorageEnabled = () => STORAGE_DRIVER === 'supabase';

const getPublicUrl = (objectPath) => {
  const supabase = getSupabaseClient();
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
};

const uploadImageBuffer = async ({ folder, file, prefix }) => {
  const supabase = getSupabaseClient();
  const ext = path.extname(file.originalname || '') || '.bin';
  const baseName = sanitizeName(path.basename(file.originalname || 'upload', ext));
  const objectPath = `${folder}/${sanitizeName(prefix)}-${Date.now()}-${baseName}${ext.toLowerCase()}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(objectPath, file.buffer, {
      cacheControl: '31536000',
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) throw error;

  return {
    objectPath,
    publicUrl: getPublicUrl(objectPath),
  };
};

const deleteByPublicUrl = async (value) => {
  if (!value || !isSupabaseStorageEnabled()) return;
  if (!PUBLIC_URL || !value.startsWith(PUBLIC_URL)) return;

  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) return;

  const objectPath = decodeURIComponent(value.slice(markerIndex + marker.length));
  if (!objectPath) return;

  const supabase = getSupabaseClient();
  await supabase.storage.from(BUCKET).remove([objectPath]);
};

module.exports = {
  BUCKET,
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
};
