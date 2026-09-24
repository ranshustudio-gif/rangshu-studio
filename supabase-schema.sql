create extension if not exists "uuid-ossp";

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  year integer,
  month integer constraint works_month_check check (month is null or month between 1 and 12),
  location text,
  type text,
  area text,
  description text,
  description_en text,
  cover_url text,
  gallery jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid references auth.users(id)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  visit_date date,
  location text,
  content text,
  cover_url text,
  gallery jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid references auth.users(id)
);

create table if not exists public.app_admin (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists works_updated_at on public.works;
create trigger works_updated_at before update on public.works for each row execute procedure public.set_updated_at();

drop trigger if exists journal_updated_at on public.journal_entries;
create trigger journal_updated_at before update on public.journal_entries for each row execute procedure public.set_updated_at();

alter table public.works enable row level security;
alter table public.journal_entries enable row level security;

create policy "Published works are readable by everyone"
on public.works for select using (status = 'published');

create policy "Published journal entries are readable by everyone"
on public.journal_entries for select using (status = 'published');

create policy "Admin can manage works"
on public.works for all using (
  exists (select 1 from public.app_admin where app_admin.id = auth.uid())
) with check (
  exists (select 1 from public.app_admin where app_admin.id = auth.uid())
);

create policy "Admin can manage journal entries"
on public.journal_entries for all using (
  exists (select 1 from public.app_admin where app_admin.id = auth.uid())
) with check (
  exists (select 1 from public.app_admin where app_admin.id = auth.uid())
);

insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;

create policy "Public read site-assets"
on storage.objects for select using (bucket_id = 'site-assets');

create policy "Admin upload site-assets"
on storage.objects for insert with check (
  bucket_id = 'site-assets'
  and auth.role() = 'authenticated'
  and exists (select 1 from public.app_admin where app_admin.id = auth.uid())
);

create policy "Admin update site-assets"
on storage.objects for update using (
  bucket_id = 'site-assets'
  and auth.role() = 'authenticated'
  and exists (select 1 from public.app_admin where app_admin.id = auth.uid())
);

create policy "Admin delete site-assets"
on storage.objects for delete using (
  bucket_id = 'site-assets'
  and auth.role() = 'authenticated'
  and exists (select 1 from public.app_admin where app_admin.id = auth.uid())
);

-- Example admin user mapping after login:
-- insert into public.app_admin (id) values ('<auth-user-uuid>');
