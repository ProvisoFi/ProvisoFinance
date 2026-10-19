-- Market-history recorder inside Supabase (pg_cron + pg_net), so the tester's 90 days of
-- Hyperliquid open interest accumulate before the ops CVM is hosted. Testnet API and the
-- testnet liquidity floor ($1k/day); switch both with the mainnet move. Once ops runs its own
-- recorder (same minute-truncated timestamps), unschedule these jobs to avoid double work.
create extension if not exists pg_net with schema extensions;

create table if not exists public.recorder_requests (
  id bigint primary key,           -- pg_net request id
  kind text not null check (kind in ('hl', 'fng')),
  requested_at timestamptz not null default now(),
  ingested_at timestamptz
);
alter table public.recorder_requests enable row level security;

create or replace function public.recorder_request_hl() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.recorder_requests (id, kind)
  values (net.http_post(
    url := 'https://api.hyperliquid-testnet.xyz/info',
    body := '{"type":"metaAndAssetCtxs"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 20000
  ), 'hl')
  -- pg_net request ids restart if the extension is reinstalled.
  on conflict (id) do update set kind = excluded.kind, requested_at = now(), ingested_at = null;
end $$;

create or replace function public.recorder_request_fng() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.recorder_requests (id, kind)
  values (net.http_get(url := 'https://api.alternative.me/fng/?limit=2', timeout_milliseconds := 20000), 'fng')
  on conflict (id) do update set kind = excluded.kind, requested_at = now(), ingested_at = null;
end $$;

-- Parses finished responses. Non-200 or vanished responses are closed after 10 minutes.
create or replace function public.recorder_ingest() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.market_snapshots (coin, ts, mark, oracle, funding, oi, volume_24h)
  select u.value->>'name',
         date_trunc('minute', q.requested_at),
         (c.value->>'markPx')::numeric,
         (c.value->>'oraclePx')::numeric,
         (c.value->>'funding')::numeric,
         (c.value->>'openInterest')::numeric,
         (c.value->>'dayNtlVlm')::numeric
  from public.recorder_requests q
  join net._http_response h on h.id = q.id and h.status_code = 200
  cross join lateral jsonb_array_elements(h.content::jsonb -> 0 -> 'universe') with ordinality as u(value, i)
  cross join lateral jsonb_array_elements(h.content::jsonb -> 1) with ordinality as c(value, j)
  where q.kind = 'hl' and q.ingested_at is null and u.i = c.j
    and coalesce((u.value->>'isDelisted')::boolean, false) = false
    and c.value->>'markPx' is not null
    and coalesce((c.value->>'dayNtlVlm')::numeric, 0) >= 1000
  on conflict do nothing;

  insert into public.fear_greed (ts, value)
  select to_timestamp((d.value->>'timestamp')::bigint), (d.value->>'value')::smallint
  from public.recorder_requests q
  join net._http_response h on h.id = q.id and h.status_code = 200
  cross join lateral jsonb_array_elements(h.content::jsonb -> 'data') as d(value)
  where q.kind = 'fng' and q.ingested_at is null
  on conflict do nothing;

  update public.recorder_requests q set ingested_at = now()
  where q.ingested_at is null
    and (exists (select 1 from net._http_response h where h.id = q.id) or q.requested_at < now() - interval '10 minutes');
end $$;

revoke execute on function public.recorder_request_hl(), public.recorder_request_fng(), public.recorder_ingest()
  from public, anon, authenticated;

select cron.schedule('recorder-hl', '* * * * *', $$select public.recorder_ingest(); select public.recorder_request_hl()$$);
select cron.schedule('recorder-fng', '17 */6 * * *', $$select public.recorder_request_fng()$$);
select cron.schedule('recorder-prune', '23 3 * * *', $$
  delete from public.market_snapshots where ts < now() - interval '100 days';
  delete from public.recorder_requests where ingested_at < now() - interval '1 day';
$$);
