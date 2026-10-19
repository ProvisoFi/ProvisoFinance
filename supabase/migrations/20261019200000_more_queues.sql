-- core consumes these: agent-key requests (Hyperliquid onboarding) and stop requests.
select pgmq.create('agent');
select pgmq.create('stop');
