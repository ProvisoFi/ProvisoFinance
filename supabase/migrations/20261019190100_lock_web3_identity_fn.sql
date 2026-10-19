-- The sign-in trigger function must not be callable through the REST API.
revoke execute on function public.handle_web3_identity() from public, anon, authenticated;
