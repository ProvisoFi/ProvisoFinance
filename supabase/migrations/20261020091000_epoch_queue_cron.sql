-- Weekly caller-share epoch (ISO week, UTC): ops computes and posts it to CallerShare.
select pgmq.create('epoch');
select cron.schedule('caller-share-epoch', '10 0 * * 1', $$
  select pgmq.send('epoch', jsonb_build_object(
    'epoch', to_char(now() - interval '1 day', 'IYYYIW')::int,
    'start', to_char(date_trunc('week', now()) - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'end', to_char(date_trunc('week', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ))
$$);
