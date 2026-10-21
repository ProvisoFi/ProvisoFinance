-- One active follow per (follower, caller, idea); a null thesis_id means all of the caller's ideas.
-- Stops follow floods that pile duplicate rows onto one caller's fire. Any active duplicates are
-- stopped first (the newest stays active), so the index always builds.
update public.follows f set active = false
where f.active and exists (
  select 1 from public.follows g
  where g.active and g.follower = f.follower and g.caller = f.caller
    and coalesce(g.thesis_id, 0) = coalesce(f.thesis_id, 0)
    and (g.created_at, g.id) > (f.created_at, f.id));

create unique index if not exists follows_active_uniq
  on public.follows (follower, caller, coalesce(thesis_id, 0)) where active;
