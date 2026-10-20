-- R4 swap keys: the enclave writes the sealed session key first, the policies are signed later.
-- Nothing has written swap_keys before this migration.
delete from public.swap_keys;
alter table public.swap_keys add column sealed jsonb not null;
alter table public.swap_keys add column setup jsonb;
alter table public.swap_keys add column registered_at timestamp with time zone;
alter table public.swap_keys alter column signed_policy drop not null;
alter table public.swap_keys alter column policy_sig drop not null;
