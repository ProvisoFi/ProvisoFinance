-- Queues, schedules and Realtime. Hand-written; drizzle-kit only manages tables.

create extension if not exists pgmq;
create extension if not exists pg_cron;

-- Work queues between the API, core (enclave) and ops workers.
select pgmq.create('stamp');      -- signed stamps for the stamper to relay
select pgmq.create('fire');       -- evaluator fires for the executor
select pgmq.create('reveal');     -- (canonical part, salt) to publish; only enqueued at fire/close
select pgmq.create('stamp_leaf'); -- evidence events to append as leaves
select pgmq.create('stamp_root'); -- hourly Merkle root jobs
select pgmq.create('sweep');      -- expiry / retire reveal deadlines
select pgmq.create('test');       -- replay requests
select pgmq.create('notify');     -- push + Telegram deliveries
select pgmq.create('route');      -- funding / exit route tracking

-- The previous hour's root, posted a few minutes after the hour closes.
select cron.schedule('stamp-root-hourly', '5 * * * *',
  $$select pgmq.send('stamp_root', jsonb_build_object('hour_start', date_trunc('hour', now()) - interval '1 hour'))$$);

select cron.schedule('reveal-sweep', '* * * * *',
  $$select pgmq.send('sweep', jsonb_build_object('at', now()))$$);

-- Sign in with Ethereum (Supabase Web3 auth) creates an auth identity; mirror its
-- wallet address into public.users so RLS and the API can key on the address.
create or replace function public.handle_web3_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  addr text := lower(coalesce(new.identity_data->>'address', substring(new.provider_id from '0x[0-9a-fA-F]{40}')));
begin
  if new.provider = 'web3' and addr ~ '^0x[0-9a-f]{40}$' then
    insert into public.users (address, auth_user_id) values (addr, new.user_id)
    on conflict (address) do update set auth_user_id = excluded.auth_user_id;
  end if;
  return new;
end $$;

create trigger on_web3_identity after insert on auth.identities
  for each row execute function public.handle_web3_identity();

-- Workspace lifecycle stream (RLS limits each user to their own rows).
alter publication supabase_realtime add table public.activity;
