-- map_ghl_inbound has to be SECURITY DEFINER (it updates ghl_inbound, which
-- authenticated users may only read). That means it should not also be exposed
-- over the REST API to every signed-in user. The edge function calls it as the
-- service role, and a manual replay runs from the SQL editor as postgres —
-- neither needs this grant.
revoke execute on function public.map_ghl_inbound(uuid) from authenticated, anon, public;;
