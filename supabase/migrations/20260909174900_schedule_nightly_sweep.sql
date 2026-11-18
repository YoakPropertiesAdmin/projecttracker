create extension if not exists pg_cron;

-- The admin token goes in Vault, not in the cron command. cron.job.command is
-- plain text and readable by anything with database access; a secret sitting
-- there is a secret in a log waiting to happen.
select vault.create_secret(
  'ghladm_rVoTQwO4aIDJkixVerZ2aGBh4A4YF4hcjV6yf6_bHz0F_r2L',
  'ghl_admin_token',
  'Bearer token for the ghl-sync and ghl-probe edge functions'
) where not exists (select 1 from vault.secrets where name = 'ghl_admin_token');

create or replace function public.run_ghl_sweep()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_token text; v_req bigint;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'ghl_admin_token';
  if v_token is null then raise exception 'ghl_admin_token not found in vault'; end if;

  select net.http_get(
    url := 'https://kkcvkvamwkjaruldypys.supabase.co/functions/v1/ghl-sync',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token),
    timeout_milliseconds := 240000
  ) into v_req;
  return v_req;
end;
$$;

revoke execute on function public.run_ghl_sweep() from public, anon, authenticated;

-- 06:00 UTC = 02:00 Eastern while daylight time is in effect. pg_cron schedules
-- in UTC only, so this becomes 01:00 once the clocks go back — still overnight,
-- still after the office has finished, which is what actually matters.
select cron.unschedule('ghl-nightly-sweep')
 where exists (select 1 from cron.job where jobname = 'ghl-nightly-sweep');

select cron.schedule('ghl-nightly-sweep', '0 6 * * *', 'select public.run_ghl_sweep()');

select jobid, jobname, schedule, active from cron.job where jobname = 'ghl-nightly-sweep';;
