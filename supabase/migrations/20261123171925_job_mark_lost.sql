-- Mark lost / Reopen from the TradeDesk job card (2026-11-23).
--
-- Lost lives in jobs.ghl_status, which started life as a mirror of the GHL
-- opportunity status. TradeDesk now decides it too, so:
--   * job_set_lost() is the one door for a manual change. Admin only (the
--     existing guard_job_columns trigger already stops non-admins editing
--     ghl_status / status_locked directly).
--   * Both directions set status_locked, so the GHL sweep and webhook leave the
--     decision alone. The Sales Log sheet sync still marks a job lost when its
--     Sales row is cancelled; the preview warns about that before a Reopen.
--   * The change is pushed to the GHL opportunity status through ghl_outbound
--     as a status-only row (target_stage_name null). The GHL Jobs/Projects
--     custom objects already follow ghl_status via jobs_ghl_object_upd.
--   * Every change is written to reconciliation_changes, which is also where a
--     Reopen finds the status the job had before it was lost.

alter table public.ghl_outbound alter column target_stage_name drop not null;
alter table public.ghl_outbound drop constraint if exists ghl_outbound_has_work;
alter table public.ghl_outbound add constraint ghl_outbound_has_work
  check (target_stage_name is not null or set_status is not null);
comment on column public.ghl_outbound.target_stage_name is
  'GHL Production stage to move the opportunity to. Null = status-only write (set_status), e.g. a job marked lost or reopened in TradeDesk.';

-- What the job card needs before it asks "are you sure".
create or replace function public.job_status_preview(p_job uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare j record; v_restore text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'only admins can mark jobs lost or reopen them' using errcode = '42501';
  end if;
  select * into j from jobs where id = p_job;
  if not found then raise exception 'job not found'; end if;

  select rc.old_text into v_restore from reconciliation_changes rc
   where rc.job_id = p_job and rc.kind = 'status'
     and rc.new_text in ('lost', 'abandoned') and rc.old_text in ('open', 'won')
   order by rc.created_at desc, rc.id desc limit 1;

  return jsonb_build_object(
    'ghl_status', j.ghl_status,
    'status_locked', j.status_locked,
    'has_opportunity', j.ghl_opportunity_id is not null,
    'restore_status', coalesce(v_restore, 'open'),
    'collected', (select coalesce(sum(amount), 0) from client_payments where job_id = p_job),
    'payment_count', (select count(*) from client_payments where job_id = p_job),
    'vendor_total', (select coalesce(sum(amount), 0) from vendor_payments where job_id = p_job),
    'vendor_count', (select count(*) from vendor_payments where job_id = p_job),
    'credit_total', (select coalesce(sum(amount), 0) from client_credits where job_id = p_job),
    'credit_count', (select count(*) from client_credits where job_id = p_job),
    'sales_cancelled', exists (select 1 from sales_log_rows s where s.job_id = p_job and s.tab = 'Sales'
                                 and s.removed_at is null and s.cancelled),
    'sales_live', exists (select 1 from sales_log_rows s where s.job_id = p_job and s.tab = 'Sales'
                            and s.removed_at is null and not s.cancelled));
end $fn$;

-- p_lost = true: mark lost. p_lost = false: reopen to the status it had before.
create or replace function public.job_set_lost(p_job uuid, p_lost boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare j record; v_new text; v_who text; v_queued boolean := false; v_kicked boolean := false;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'only admins can mark jobs lost or reopen them' using errcode = '42501';
  end if;
  select * into j from jobs where id = p_job for update;
  if not found then raise exception 'job not found'; end if;

  if p_lost then
    if j.ghl_status in ('lost', 'abandoned') then
      return jsonb_build_object('changed', false, 'ghl_status', j.ghl_status);
    end if;
    v_new := 'lost';
  else
    if j.ghl_status not in ('lost', 'abandoned') then
      return jsonb_build_object('changed', false, 'ghl_status', j.ghl_status);
    end if;
    v_new := coalesce((public.job_status_preview(p_job)) ->> 'restore_status', 'open');
  end if;

  select email into v_who from auth.users where id = auth.uid();

  update jobs set ghl_status = v_new, status_locked = true where id = p_job;

  insert into reconciliation_changes(batch, job_id, job_number, kind, old_text, new_text, note)
  values ('manual_' || to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD'),
          p_job, j.number, 'status', j.ghl_status, v_new,
          case when p_lost then 'Marked lost' else 'Reopened' end || ' in TradeDesk'
          || coalesce(' by ' || v_who, '')
          || coalesce(': ' || nullif(btrim(p_note), ''), ''));

  if j.ghl_opportunity_id is not null then
    -- A newer decision replaces any status write still waiting to go out.
    update ghl_outbound set status = 'skipped', note = 'superseded by a newer TradeDesk status change'
     where job_id = p_job and status = 'pending' and target_stage_name is null;
    insert into ghl_outbound (job_id, opportunity_id, target_stage_name, set_status, reason)
    values (p_job, j.ghl_opportunity_id, null, v_new,
            'TradeDesk ' || case when p_lost then 'marked lost' else 'reopened' end
            || ' (' || j.ghl_status || ' -> ' || v_new || ')');
    v_queued := true;
    begin
      perform public.kick_ghl_outbound();
      v_kicked := true;
    exception when others then
      v_kicked := false; -- row stays pending; outbound_stuck reports it
    end;
  end if;

  return jsonb_build_object('changed', true, 'ghl_status', v_new, 'previous', j.ghl_status,
                            'ghl_queued', v_queued, 'ghl_kicked', v_kicked);
end $fn$;

revoke execute on function public.job_status_preview(uuid) from public, anon;
revoke execute on function public.job_set_lost(uuid, boolean, text) from public, anon;
grant execute on function public.job_status_preview(uuid) to authenticated;
grant execute on function public.job_set_lost(uuid, boolean, text) to authenticated;

-- Check-and-report: lost or abandoned jobs that still carry money. Their cash
-- stays in the Ledger's Payment reports but they are out of Booked, the
-- Scorecard and Balances owed, so each one deserves a human look.
insert into public.health_checks (check_key, label, severity, query, description)
values ('lost_job_has_money', 'Lost job with money attached', 'warn',
$q$select j.id::text as ref,
   'JOB-' || lpad(j.number::text, 4, '0') || ' ' || j.customer_name || ' is ' || j.ghl_status || ' but has money recorded' as title,
   jsonb_build_object('job', 'JOB-' || lpad(j.number::text, 4, '0'), 'status', j.ghl_status,
     'collected', coalesce(p.amt, 0), 'vendor_costs', coalesce(v.amt, 0), 'credits', coalesce(c.amt, 0)) as detail
 from jobs j
 left join (select job_id, sum(amount) amt from client_payments group by 1) p on p.job_id = j.id
 left join (select job_id, sum(amount) amt from vendor_payments group by 1) v on v.job_id = j.id
 left join (select job_id, sum(amount) amt from client_credits group by 1) c on c.job_id = j.id
 where j.ghl_status in ('lost', 'abandoned')
   and (coalesce(p.amt, 0) <> 0 or coalesce(v.amt, 0) <> 0 or coalesce(c.amt, 0) <> 0)$q$,
 'A lost/abandoned job has client payments, vendor costs or credits. That money still shows in Ledger > Payment reports (tagged Lost) but not in Booked, the Scorecard or Balances owed. Confirm the job really is lost, or refund/move the money.')
on conflict (check_key) do update set label = excluded.label, query = excluded.query,
  description = excluded.description, updated_at = now();
