-- A swap wallet serves one account at a time: unique among live (non-revoked) keys only, so a
-- revoked record never has to be deleted to free its wallet.
alter table public.swap_keys drop constraint swap_keys_account_uniq;
create unique index swap_keys_account_live on public.swap_keys (account) where revoked_at is null;
