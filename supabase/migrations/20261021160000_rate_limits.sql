-- Per-address request budgets for the API (writer, tester, stamps, swap setup/revoke...).
-- Fixed windows; the API runs on many serverless instances, so the count lives here.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;

-- Counts one hit for `p_key` in the current window and says whether it is within `p_max`.
-- Atomic under concurrency (one upsert); the key's older windows are dropped as it goes.
create or replace function public.rate_limit_hit(p_key text, p_max integer, p_window_s integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  n integer;
begin
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning r.hits into n;
  delete from public.rate_limits where key = p_key and window_start < w;
  return n <= p_max;
end $$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
