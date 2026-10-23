-- Call announcements opt-in (expansion section 6 #2): off unless the caller switches it on.
-- announce_since: when they did (null = off). Only calls sealed after it may be posted by the
-- X / Telegram bot, so switching it on never announces older calls.
alter table public.users add column if not exists announce_since timestamptz;
