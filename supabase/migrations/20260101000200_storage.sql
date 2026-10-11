-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  Migration 3 of 4  ·  STORAGE
-- ============================================================================
--  Creates the public bucket that holds item photographs and locks uploads
--  down to the uploader's own folder:
--
--      item-images/<user-id>/<random-name>.jpg
--
--  A student can therefore never overwrite or delete somebody else's photo,
--  and no student can write outside their own folder even if they call the
--  Storage API directly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The bucket
--    * public = true      -> image URLs work without signed tokens
--    * 5 MB size limit    -> enforced by Storage itself
--    * mime whitelist     -> JPG / JPEG / PNG / WEBP only
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'item-images',
  'item-images',
  true,
  5242880,                                                   -- 5 MB
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Access policies on storage.objects
-- ---------------------------------------------------------------------------

-- anyone (including logged-out visitors) may view item photos
drop policy if exists "item images are publicly readable" on storage.objects;
create policy "item images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'item-images');

-- an authenticated user may only upload into a folder named after their uid
drop policy if exists "users upload item images into their own folder" on storage.objects;
create policy "users upload item images into their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ... and may replace/remove only their own files
drop policy if exists "users update their own item images" on storage.objects;
create policy "users update their own item images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete their own item images" on storage.objects;
create policy "users delete their own item images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Administrators can clean up any image (used when moderating a report)
drop policy if exists "admins manage all item images" on storage.objects;
create policy "admins manage all item images"
  on storage.objects for all to authenticated
  using (bucket_id = 'item-images' and public.is_admin())
  with check (bucket_id = 'item-images' and public.is_admin());

-- ============================================================================
--  End of migration 3.  Next: 20260101000300_functions_views.sql
-- ============================================================================
