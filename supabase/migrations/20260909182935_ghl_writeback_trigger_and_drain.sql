-- Drain the queue. Token lives in Vault, never in the function body or in
-- cron.job.command, both of which are readable plain text.
create or replace function public.kick_ghl_outbound()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_token text; v_req bigint;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'ghl_admin_token';
  if v_token is null then raise exception 'ghl_admin_token not found in vault'; end if;
  select net.http_post(
    url := 'https://kkcvkvamwkjaruldypys.supabase.co/functions/v1/ghl-outbound',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token,
                                  'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000) into v_req;
  return v_req;
end;
$$;

revoke execute on function public.kick_ghl_outbound() from public, anon, authenticated;

-- Enqueue on a real TradeDesk-side stage change.
create or replace function public.queue_ghl_writeback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare t record;
begin
  if new.stage is not distinct from old.stage then return new; end if;
  if new.ghl_opportunity_id is null then return new; end if;

  select * into t from public.ghl_writeback_targets
   where td_stage = new.stage and active;
  if not found then return new; end if;

  -- THE LOOP GUARD. substage holds the GHL stage this job was last known to be
  -- in. When the change came FROM GoHighLevel — an inbound webhook or the
  -- nightly sweep, both of which set stage and substage together — substage
  -- already equals the target, so there is nothing to push back and no cycle.
  -- Only a move made inside TradeDesk leaves substage lagging.
  if new.substage is not distinct from t.ghl_stage_name then return new; end if;

  insert into public.ghl_outbound (job_id, opportunity_id, target_stage_name, set_status, reason)
  values (new.id, new.ghl_opportunity_id, t.ghl_stage_name, t.set_status,
          'TradeDesk stage ' || coalesce(old.stage, '(none)') || ' -> ' || new.stage)
  on conflict (job_id, target_stage_name) where status = 'pending'
  do update set opportunity_id = excluded.opportunity_id,
                set_status     = excluded.set_status,
                reason         = excluded.reason,
                created_at     = now();

  perform public.kick_ghl_outbound();
  return new;
end;
$$;

revoke execute on function public.queue_ghl_writeback() from public, anon, authenticated;

drop trigger if exists jobs_ghl_writeback on public.jobs;
create trigger jobs_ghl_writeback
  after update of stage on public.jobs
  for each row execute function public.queue_ghl_writeback();

-- Safety net: anything the immediate kick missed (CRM outage, pg_net hiccup)
-- is retried on a schedule. Attempts are capped at 5 in the edge function.
select cron.schedule('ghl-outbound-retry', '*/15 * * * *', 'select public.kick_ghl_outbound()');;
