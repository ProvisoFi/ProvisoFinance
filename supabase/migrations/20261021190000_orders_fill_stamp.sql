-- Every fill becomes a FILL stamp leaf: Hyperliquid orders and Robinhood Chain swaps, caller and
-- follower, entry and exit. Fires on the first fill and again whenever the filled size grows
-- (an IOC partial is final). ops' stamp_leaf consumer files it under the hour it arrives.
-- The account is left out: leaf data is public through stamp proofs.
create or replace function public.orders_fill_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('partial', 'filled') and new.filled_size > 0
     and (tg_op = 'INSERT' or new.filled_size is distinct from old.filled_size) then
    perform pgmq.send('stamp_leaf', jsonb_build_object(
      'thesisId', new.thesis_id::text,
      'kind', 'FILL',
      'at', to_jsonb(new.updated_at),
      'data', jsonb_build_object(
        'orderId', new.id,
        'fireId', new.fire_id,
        'role', new.role,
        'wave', new.wave,
        'venue', new.venue,
        'coin', new.coin,
        'side', new.side,
        'reduceOnly', new.reduce_only,
        'size', new.size::text,
        'filled', new.filled_size::text,
        'avgPx', new.avg_px::text,
        'at', to_jsonb(new.updated_at))));
  end if;
  return new;
end $$;

revoke execute on function public.orders_fill_stamp() from public, anon, authenticated;

drop trigger if exists orders_fill_stamp on public.orders;
create trigger orders_fill_stamp after insert or update of status, filled_size on public.orders
  for each row execute function public.orders_fill_stamp();
