-- User preferences table for Newsletter AI
-- Run this in your Supabase project SQL editor or as a migration.

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  interests text,
  timeline text,
  unsubscribed boolean default false not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.user_prefs
  add column if not exists send_timezone text default 'UTC';

alter table public.user_prefs
  add column if not exists send_hour smallint default 9;

alter table public.user_prefs
  add column if not exists send_minute smallint default 0;

-- Keep updated_at fresh on writes
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_user_prefs_updated_at on public.user_prefs;
create trigger set_user_prefs_updated_at
before update on public.user_prefs
for each row execute function public.set_updated_at();

-- Row Level Security
alter table public.user_prefs enable row level security;

-- Policies: users can read and write only their own row
drop policy if exists "Users can select own prefs" on public.user_prefs;
create policy "Users can select own prefs"
  on public.user_prefs
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own prefs" on public.user_prefs;
create policy "Users can insert own prefs"
  on public.user_prefs
  for insert
  with check (auth.uid() = user_id);

-- ============================================
-- One-time token nonce store
-- ============================================

create table if not exists public.used_nonces (
  nonce text primary key,
  used_at timestamptz not null default now()
);

drop policy if exists "Users can update own prefs" on public.user_prefs;
create policy "Users can update own prefs"
  on public.user_prefs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Ensure send time columns remain within a sane range
do $$
begin
  alter table public.user_prefs
    add constraint user_prefs_send_hour_check
    check (send_hour between 0 and 23);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.user_prefs
    add constraint user_prefs_send_minute_check
    check (send_minute between 0 and 59);
exception when duplicate_object then null;
end $$;

-- ============================================
-- Articles
-- ============================================

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  summary text,
  tags jsonb,
  source text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.articles
  add column if not exists source text;

drop trigger if exists set_articles_updated_at on public.articles;
create trigger set_articles_updated_at
before update on public.articles
for each row execute function public.set_updated_at();

alter table public.articles enable row level security;

-- Allow anyone (anon or authenticated) to read articles
drop policy if exists "Anyone can read articles" on public.articles;
create policy "Anyone can read articles"
  on public.articles
  for select
  using (true);

-- ============================================
-- Surveys (feedback)
-- ============================================

create table if not exists public.surveys (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references public.articles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  question text,
  answer text,
  meta jsonb,
  created_at timestamptz default now() not null
);

create index if not exists surveys_article_id_idx on public.surveys(article_id);
create index if not exists surveys_created_at_idx on public.surveys(created_at desc);

alter table public.surveys enable row level security;

-- Authenticated users can select their own survey responses
drop policy if exists "Users can read own surveys" on public.surveys;
create policy "Users can read own surveys"
  on public.surveys
  for select
  using (auth.uid() = user_id);

-- Authenticated users can insert surveys for themselves
drop policy if exists "Users can insert own surveys" on public.surveys;
create policy "Users can insert own surveys"
  on public.surveys
  for insert
  with check (auth.uid() = user_id);
