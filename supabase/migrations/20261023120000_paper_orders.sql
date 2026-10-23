-- Proviso Paper (expansion #5): simulated fills are stored as orders with venue 'paper', so the
-- orders_fill_stamp trigger stamps them like live fills (the leaf's fillModel is "paper-v1").
alter table public.orders drop constraint if exists orders_venue;
alter table public.orders add constraint orders_venue check (venue in ('hl', 'rhc', 'paper'));
