-- core <-> ops: new X posts for matching, and one-tap copy confirms from Telegram.
select pgmq.create('posts');
select pgmq.create('confirm');
