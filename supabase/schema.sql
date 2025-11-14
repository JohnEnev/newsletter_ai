-- User preferences table for Newsletter AI
-- Run this in your Supabase project SQL editor or as a migration.

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  interests text,
  timeline text,
  unsubscribed boolean default false not null,
  last_digest_sent_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.user_prefs
  add column if not exists send_timezone text default 'UTC';

alter table public.user_prefs
  add column if not exists send_hour smallint default 9;

alter table public.user_prefs
  add column if not exists send_minute smallint default 0;

alter table public.user_prefs
  add column if not exists last_digest_sent_at timestamptz;

alter table public.user_prefs
  add column if not exists last_digest_article_ids jsonb;

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

alter table public.used_nonces enable row level security;

drop policy if exists "Service role inserts nonces" on public.used_nonces;
create policy "Service role inserts nonces"
  on public.used_nonces
  for all
  using (false)
  with check (false);

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
  hook_question text,
  tags jsonb,
  primary_tag text,
  source text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.articles
  add column if not exists source text;

alter table public.articles
  add column if not exists primary_tag text;

alter table public.articles
  add column if not exists hook_question text;

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

-- ============================================
-- Topics & feeds
-- ============================================

create table if not exists public.article_topics (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text,
  description text,
  metadata jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create table if not exists public.article_topic_feeds (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.article_topics(id) on delete cascade,
  feed_url text not null unique,
  status text not null default 'active',
  last_synced_at timestamptz,
  metadata jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create table if not exists public.interest_gap_reports (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  user_id uuid references auth.users(id) on delete set null,
  reported_at timestamptz not null default now()
);

create index if not exists interest_gap_reports_slug_idx on public.interest_gap_reports(slug);
create index if not exists interest_gap_reports_reported_idx on public.interest_gap_reports(reported_at desc);

create table if not exists public.feed_discovery_audit (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  provider text,
  requested smallint,
  added smallint,
  skipped smallint,
  errors jsonb,
  metadata jsonb,
  created_at timestamptz default now() not null
);

create index if not exists feed_discovery_audit_slug_idx on public.feed_discovery_audit(slug, created_at desc);

create table if not exists public.user_interest_topics (
  user_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid not null references public.article_topics(id) on delete cascade,
  weight numeric,
  source text,
  inferred boolean default false,
  metadata jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  primary key (user_id, topic_id)
);

create table if not exists public.article_topic_links (
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid not null references public.article_topics(id) on delete cascade,
  confidence numeric,
  created_at timestamptz default now() not null,
  primary key (article_id, topic_id)
);

drop trigger if exists set_article_topics_updated_at on public.article_topics;
create trigger set_article_topics_updated_at
before update on public.article_topics
for each row execute function public.set_updated_at();

drop trigger if exists set_article_topic_feeds_updated_at on public.article_topic_feeds;
create trigger set_article_topic_feeds_updated_at
before update on public.article_topic_feeds
for each row execute function public.set_updated_at();

drop trigger if exists set_user_interest_topics_updated_at on public.user_interest_topics;
create trigger set_user_interest_topics_updated_at
before update on public.user_interest_topics
for each row execute function public.set_updated_at();

alter table public.article_topics enable row level security;
alter table public.article_topic_feeds enable row level security;
alter table public.user_interest_topics enable row level security;
alter table public.article_topic_links enable row level security;
