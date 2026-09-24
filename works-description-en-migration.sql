alter table public.works
  add column if not exists description_en text;

notify pgrst, 'reload schema';
