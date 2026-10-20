-- One Proviso account per person: swap_keys stays keyed by the account (the sign-in wallet) and
-- records the wallet that actually swaps (the Kernel smart account, an embedded wallet) in
-- `account`. A swap wallet belongs to one account only.
alter table public.swap_keys add column account text;
update public.swap_keys set account = address where account is null;
alter table public.swap_keys alter column account set not null;
alter table public.swap_keys add constraint swap_keys_account_uniq unique (account);
