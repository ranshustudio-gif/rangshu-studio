-- Supabase Storage policies for the public `site-assets` bucket.
-- Run this file in the Supabase SQL Editor. It does not upload or remove files.
--
-- This project uploads assets beneath paths such as:
--   works/covers/, works/gallery/, journal/covers/, journal/gallery/
-- Policies deliberately allow every object path in site-assets so new asset
-- paths used by the admin do not require a policy change.

-- Keep the bucket public so public image URLs can be read by the website.
insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do update set public = true;

-- Replace the policies with the same names when this file is re-run.
drop policy if exists "Public read site-assets" on storage.objects;
drop policy if exists "Authenticated upload site-assets" on storage.objects;
drop policy if exists "Authenticated update site-assets" on storage.objects;
drop policy if exists "Authenticated delete site-assets" on storage.objects;

-- These were used by the prior project schema; remove them so every signed-in
-- user has the access requested here, without retaining a second restriction.
drop policy if exists "Admin upload site-assets" on storage.objects;
drop policy if exists "Admin update site-assets" on storage.objects;
drop policy if exists "Admin delete site-assets" on storage.objects;

-- Public reads: required for public-site access through the Storage API.
create policy "Public read site-assets"
on storage.objects
for select
to public
using (bucket_id = 'site-assets');

-- Writes are limited to signed-in users. No path/folder restriction is applied.
create policy "Authenticated upload site-assets"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'site-assets');

-- Both clauses prevent an update from moving an object out of site-assets.
create policy "Authenticated update site-assets"
on storage.objects
for update
to authenticated
using (bucket_id = 'site-assets')
with check (bucket_id = 'site-assets');

create policy "Authenticated delete site-assets"
on storage.objects
for delete
to authenticated
using (bucket_id = 'site-assets');
