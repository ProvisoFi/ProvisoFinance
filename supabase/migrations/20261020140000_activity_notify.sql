-- Every lifecycle event already writes an `activity` row (core runtime, executor, ops, API).
-- This turns the user-facing ones into `notify` messages for the ops sender (Web Push +
-- Telegram), in one place. Messages carry ids and states only, never rule contents, and are
-- queued only when the address has a delivery channel.
create or replace function public.activity_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := new.payload;
  tid text := coalesce(p->>'thesisId', '');
  ref text := case when tid = '' then 'Your idea' else 'Thesis #' || tid end;
  title text;
  body text;
  url text := 'https://provisofi.com/dashboard/records/';
  msg jsonb;
  follow_id uuid;
begin
  if not exists (select 1 from public.telegram_links where address = new.address)
     and not exists (select 1 from public.push_subscriptions where address = new.address) then
    return new;
  end if;

  case new.kind
    when 'sealed' then title := 'Idea sealed'; body := ref || ' is sealed on Robinhood Chain.';
    when 'fired' then title := 'Idea fired'; body := ref || ' fired at mark ' || coalesce(p->>'mark', '?') || '. Its entry is now public.';
    when 'revealed' then title := 'Rule revealed'; body := ref || ': the ' || coalesce(p->>'part', 'rule') || ' is revealed on chain.';
    when 'expired' then title := 'Idea expired'; body := ref || ' expired. Its entry will be revealed for the record.';
    when 'retired' then title := 'Idea retired'; body := ref || ' is retired. Its entry is revealed within 24 hours.';
    when 'closed' then title := 'Position closed'; body := ref || ': the position is closed and the exit is revealed.';
    when 'stopped' then title := 'Idea stopped'; body := ref || ' is stopped.';
    when 'idea_invalid' then title := 'Idea stopped'; body := ref || ' was stopped: its sealed rule did not match the on-chain commitment.';
    when 'unrevealed_after_expiry' then title := 'Reveal overdue'; body := ref || ' passed its reveal deadline; the record shows it as unrevealed.';
    when 'exit' then title := 'Exit executed'; body := ref || ': the exit ran (' || coalesce(p->>'reason', 'exit') || ').';
    when 'exit_incomplete' then title := 'Exit incomplete'; body := ref || ': the exit did not fully fill. Check your position.';
    when 'closed_by_venue' then title := 'Closed on Hyperliquid'; body := ref || ': the venue closed the position (stop or liquidation).';
    when 'needs_onboarding' then title := 'Connect Hyperliquid'; body := ref || ' could not trade: connect your Hyperliquid account first.'; url := 'https://provisofi.com/dashboard/connections/';
    when 'copy_confirmed' then title := 'Copy placed'; body := ref || ': your copy order was placed.';
    when 'copy_confirm_failed' then title := 'Copy not filled'; body := ref || ': your copy order did not fill.';
    when 'copy_confirm_expired' then title := 'Copy window closed'; body := ref || ': the confirm window has passed.';
    when 'copy_confirm_required' then
      title := 'Confirm copy';
      body := ref || ' fired. Tap to copy it (' || coalesce(p->>'side', '') || ' ' || coalesce(p->>'coin', '') || ').';
      url := 'https://provisofi.com/dashboard/fair-copy/';
      select f.id into follow_id from public.follows f
       where f.follower = new.address and f.caller = lower(coalesce(p->>'caller', '')) and f.active
         and (f.thesis_id is null or f.thesis_id::text = tid)
       order by (f.thesis_id is not null) desc, f.created_at desc limit 1;
    else return new;
  end case;

  msg := jsonb_build_object('address', new.address, 'title', title, 'body', body, 'url', url);
  if follow_id is not null and p ? 'fireId' then
    msg := msg || jsonb_build_object('confirm', jsonb_build_object('followId', follow_id, 'thesisId', tid, 'fireId', p->>'fireId'));
  end if;
  perform pgmq.send('notify', msg);
  return new;
end $$;

revoke execute on function public.activity_notify() from public, anon, authenticated;

drop trigger if exists on_activity_notify on public.activity;
create trigger on_activity_notify after insert on public.activity
  for each row execute function public.activity_notify();
