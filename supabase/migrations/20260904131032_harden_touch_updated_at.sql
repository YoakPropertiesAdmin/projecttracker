-- The updated_at trigger helper needs no elevated rights and should not be
-- callable over the REST API. Drop it to SECURITY INVOKER and take EXECUTE
-- away from the API roles; trigger execution is unaffected.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;;
