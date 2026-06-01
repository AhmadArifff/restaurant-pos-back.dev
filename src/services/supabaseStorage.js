const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'restaurant-pos-assets';

const hasSupabaseConfig = () => Boolean(
  process.env.SUPABASE_URL
  && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
);

const getStorageDriver = () => {
  const configured = String(process.env.STORAGE_DRIVER || '').toLowerCase();
  if (configured) return configured;
  return process.env.VERCEL && hasSupabaseConfig() ? 'supabase' : 'local';
};

const getSupabaseClient = () => {
  if (getStorageDriver() !== 'supabase') return null;

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

const isSupabaseStorageEnabled = () => getStorageDriver() === 'supabase';

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
