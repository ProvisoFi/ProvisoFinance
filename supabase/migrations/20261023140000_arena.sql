-- Proviso Arena (expansion.md section 6): weekly seasons of sealed paper calls, AI models and humans.
-- reveals.canonical keeps the revealed part's canonical JSON (already public on ThesisSeal), so the
-- Arena and call pages can show a fired rule in plain English without reading the chain.
alter table public.reveals add column if not exists canonical text;

create table if not exists public.arena_entries (
  id uuid primary key default gen_random_uuid(),
  season text not null,
  address text not null,
  entrant text not null,
  thesis_id bigint references public.theses(id),
  stamp_request_id uuid references public.stamp_requests(id),
  created_at timestamptz not null default now(),
  constraint arena_entries_season_address unique (season, address)
);
create index if not exists arena_entries_season_idx on public.arena_entries (season);
alter table public.arena_entries enable row level security;
