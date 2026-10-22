-- Ops' own record of when it first saw each wallet hold the sponsorship floor (1 USDG or 0.0002 ETH
-- on mainnet): the Robinhood Chain RPC keeps no history. Sponsored gas (seals, swap setups) needs a
-- wallet seen funded for SPONSOR_MIN_AGE_S; seeing it below the floor deletes its row (budget.ts).
create table public.sponsor_funding (
  address text primary key,
  first_seen_funded_at timestamptz not null,
  seen_at timestamptz not null
);
alter table public.sponsor_funding enable row level security;
