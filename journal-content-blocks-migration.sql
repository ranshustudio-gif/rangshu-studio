alter table public.journal_entries
  add column if not exists content_blocks jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
