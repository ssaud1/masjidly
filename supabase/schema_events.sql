-- Run in Supabase SQL editor once.
create extension if not exists pgcrypto;

create table if not exists public.events (
  event_uid text primary key,
  source text not null,
  source_type text not null default '',
  source_url text not null default '',
  title text not null,
  description text not null default '',
  date date,
  start_time text not null default '',
  end_time text not null default '',
  location_name text not null default '',
  address text not null default '',
  city text not null default '',
  state text not null default '',
  zip text not null default '',
  category text not null default '',
  audience text not null default '',
  organizer text not null default '',
  rsvp_link text not null default '',
  image_urls jsonb not null default '[]'::jsonb,
  image_review_urls jsonb not null default '[]'::jsonb,
  speaker text not null default '',
  confidence double precision not null default 0,
  is_future boolean not null default false,
  sync_batch_id text not null,
  updated_at timestamptz not null default now()
);

create index if not exists events_source_idx on public.events (source);
create index if not exists events_date_idx on public.events (date);
create index if not exists events_future_idx on public.events (is_future, date);

