-- Supabase Web3 identities carry the wallet in identity_data.custom_claims.address
-- (verified on the first real sign-in, 2026-10-20). Read it first; keep the older fallbacks.
create or replace function public.handle_web3_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  addr text := lower(coalesce(
    new.identity_data->'custom_claims'->>'address',
    new.identity_data->>'address',
    substring(new.provider_id from '0x[0-9a-fA-F]{40}')
  ));
begin
  if new.provider = 'web3' and addr ~ '^0x[0-9a-f]{40}$' then
    insert into public.users (address, auth_user_id) values (addr, new.user_id)
    on conflict (address) do update set auth_user_id = excluded.auth_user_id;
  end if;
  return new;
end $$;

revoke execute on function public.handle_web3_identity() from public, anon, authenticated;
