-- Ops watcher state that must survive a restart (services/ops/src/runtime/alerts.ts): the
-- CallerShare log cursor and the last 24 h of claims, keyed by watcher name.
create table public.ops_watch (
  key text primary key,
  value jsonb not null
);
alter table public.ops_watch enable row level security;
