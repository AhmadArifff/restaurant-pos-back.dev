-- Supabase Storage setup for Restaurant POS assets.
-- Run after schema.sql in Supabase SQL Editor.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-pos-assets',
  'restaurant-pos-assets',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read for the public bucket. Upload/update/delete should be done by backend service role key.
drop policy if exists "restaurant_pos_assets_public_read" on storage.objects;
create policy "restaurant_pos_assets_public_read"
on storage.objects
for select
to public
using (bucket_id = 'restaurant-pos-assets');
