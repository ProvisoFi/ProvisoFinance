-- Optional public display name for a caller's profile (/c/<address>). The address stays the identity:
-- names are unverified, so the app always shows the short address beside them.
-- 3-24 characters, letters, digits, _ . -, starting and ending with a letter or digit;
-- unique regardless of case, so nobody can take another caller's name with different capitals.
alter table public.users add column if not exists display_name text;
alter table public.users drop constraint if exists users_display_name_format;
alter table public.users add constraint users_display_name_format
  check (display_name is null or display_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,22}[A-Za-z0-9]$');
create unique index if not exists users_display_name_lower_uniq
  on public.users (lower(display_name)) where display_name is not null;
