-- Run this once in the Supabase SQL Editor for an existing project.
-- public.works already has year in this project; IF NOT EXISTS keeps this safe.
alter table public.works
  add column if not exists year integer;

alter table public.works
  add column if not exists month integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'works_month_check'
      and conrelid = 'public.works'::regclass
  ) then
    alter table public.works
      add constraint works_month_check
      check (month is null or month between 1 and 12);
  end if;
end
$$;

notify pgrst, 'reload schema';
