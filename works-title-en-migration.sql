-- Run this once in the Supabase SQL Editor before entering English work titles.
alter table public.works
add column if not exists title_en text;
