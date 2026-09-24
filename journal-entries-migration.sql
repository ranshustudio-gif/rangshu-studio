-- Run in the Supabase SQL Editor only if this project was created from an
-- earlier journal_entries schema. Every statement preserves existing data.
alter table public.journal_entries
  add column if not exists location text,
  add column if not exists content text,
  add column if not exists cover_url text,
  add column if not exists gallery jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'draft',
  add column if not exists published_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

-- The public Journal pages can read only records explicitly marked published.
alter table public.journal_entries enable row level security;
drop policy if exists "Published journal entries are readable by everyone" on public.journal_entries;
create policy "Published journal entries are readable by everyone"
on public.journal_entries
for select
to public
using (status = 'published');
