-- A swap about to run marks its test feed urgent: ops then pushes it on the adapter's 60 s clock
-- instead of the slower idle one (feeds an idea only reads).
alter table public.feed_wanted add column urgent_until timestamp with time zone;
