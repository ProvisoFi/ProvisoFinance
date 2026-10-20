-- The ops CVM now records HL snapshots, Fear & Greed and pruning itself (verified writing every
-- minute with the cron paused), so the stopgap Supabase recorder jobs would only fetch twice.
-- The functions stay, so the jobs can be rescheduled if ops is ever down for long.
select cron.unschedule(jobname) from cron.job where jobname in ('recorder-hl', 'recorder-fng', 'recorder-prune');
