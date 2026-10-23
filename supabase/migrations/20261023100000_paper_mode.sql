-- Calls may be "paper" (simulated, no money moves) alongside "live" and "alert"; stamp leaves carry
-- the mode from schema v2 (services/ops/src/stamps/leaf.ts), so paper and live records stay apart.
alter table public.theses drop constraint if exists theses_mode;
alter table public.theses add constraint theses_mode check (mode in ('live', 'alert', 'paper'));
