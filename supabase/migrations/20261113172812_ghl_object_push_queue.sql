-- Jobs whose GHL Job/Project records need a push. Debounced: a burst of edits becomes one push.
create table if not exists public.ghl_object_queue (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  queued_at timestamptz not null default now()
);
alter table public.ghl_object_queue enable row level security;
comment on table public.ghl_object_queue is 'TradeDesk jobs whose GHL Job/Project records must be pushed (TradeDesk -> GHL only). Drained every minute by ghl_object_queue_drain().';

create or replace function public.ghl_object_enqueue(p_job uuid)
returns void language sql security definer set search_path = public as $f$
  insert into ghl_object_queue(job_id) select p_job where exists (select 1 from jobs where id = p_job and ghl_opportunity_id is not null)
  on conflict (job_id) do update set queued_at = now();
$f$;

create or replace function public.trg_jobs_ghl_object() returns trigger
language plpgsql security definer set search_path = public as $f$
begin perform ghl_object_enqueue(new.id); return null; end $f$;

create or replace function public.trg_related_ghl_object() returns trigger
language plpgsql security definer set search_path = public as $f$
begin
  if tg_op in ('INSERT','UPDATE') and new.job_id is not null then perform ghl_object_enqueue(new.job_id); end if;
  if tg_op in ('UPDATE','DELETE') and old.job_id is not null then perform ghl_object_enqueue(old.job_id); end if;
  return null;
end $f$;

drop trigger if exists jobs_ghl_object_ins on public.jobs;
create trigger jobs_ghl_object_ins after insert on public.jobs
  for each row when (new.ghl_opportunity_id is not null) execute function public.trg_jobs_ghl_object();

drop trigger if exists jobs_ghl_object_upd on public.jobs;
create trigger jobs_ghl_object_upd after update on public.jobs
  for each row when (new.ghl_opportunity_id is not null and
    (old.ghl_opportunity_id, old.ghl_project_display_id, old.ghl_contact_id, old.customer_name, old.customer_address,
     old.contract_amount, old.stage, old.ghl_status, old.paid_status, old.trades, old.is_repair, old.contract_signed_date, old.flag)
    is distinct from
    (new.ghl_opportunity_id, new.ghl_project_display_id, new.ghl_contact_id, new.customer_name, new.customer_address,
     new.contract_amount, new.stage, new.ghl_status, new.paid_status, new.trades, new.is_repair, new.contract_signed_date, new.flag))
  execute function public.trg_jobs_ghl_object();

drop trigger if exists job_assignments_ghl_object on public.job_assignments;
create trigger job_assignments_ghl_object after insert or update or delete on public.job_assignments
  for each row execute function public.trg_related_ghl_object();

drop trigger if exists completion_log_rows_ghl_object on public.completion_log_rows;
create trigger completion_log_rows_ghl_object after insert or update or delete on public.completion_log_rows
  for each row execute function public.trg_related_ghl_object();

-- Push queued jobs that have been quiet for 20 s, 30 at a time.
create or replace function public.ghl_object_queue_drain()
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_ids uuid[]; v_req bigint;
begin
  with picked as (
    delete from ghl_object_queue where job_id in (
      select job_id from ghl_object_queue where queued_at < now() - interval '20 seconds' order by queued_at limit 30)
    returning job_id)
  select array_agg(job_id) into v_ids from picked;
  if v_ids is null then return jsonb_build_object('sent', 0); end if;
  select net.http_post(
    url := 'https://kkcvkvamwkjaruldypys.supabase.co/functions/v1/td-ghl-objects',
    headers := jsonb_build_object('content-type','application/json','authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ghl_admin_token')),
    body := jsonb_build_object('action','sync','run_id','push_' || to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI'),'job_ids', to_jsonb(v_ids)),
    timeout_milliseconds := 30000) into v_req;
  return jsonb_build_object('sent', cardinality(v_ids), 'request', v_req);
end $f$;

create or replace function public.ghl_object_check()
returns bigint language sql security definer set search_path = public as $f$
  select net.http_post(
    url := 'https://kkcvkvamwkjaruldypys.supabase.co/functions/v1/td-ghl-objects',
    headers := jsonb_build_object('content-type','application/json','authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ghl_admin_token')),
    body := jsonb_build_object('action','check','run_id','check_' || to_char(now() at time zone 'utc','YYYY-MM-DD')),
    timeout_milliseconds := 30000);
$f$;

revoke all on function public.ghl_object_enqueue(uuid) from public, anon, authenticated;
revoke all on function public.ghl_object_queue_drain() from public, anon, authenticated;
revoke all on function public.ghl_object_check() from public, anon, authenticated;

select cron.schedule('ghl-object-push', '* * * * *', $$select public.ghl_object_queue_drain()$$);
-- Read-only comparison at 6:10 AM Eastern, before the 6:30 digest.
select cron.schedule('ghl-object-check', '10 11 * * *', $$select public.ghl_object_check()$$);;
