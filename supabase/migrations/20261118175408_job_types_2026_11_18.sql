create table if not exists public.job_types (
  key text primary key,
  label text not null,
  sort int not null,
  expects_project_id boolean not null default false,
  name_pattern text,
  active boolean not null default true
);
comment on table public.job_types is
  'Job type registry. expects_project_id: a live job of this type with no GHL project # goes on the morning email. name_pattern: a job whose name matches is given this type automatically.';
insert into public.job_types (key, label, sort, expects_project_id, name_pattern) values
  ('renew',   'Renew',   1, false, null),
  ('rehab',   'Rehab',   2, true,  null),
  ('yoak_pm', 'Yoak PM', 3, false, 'yoak\s*pm')
on conflict (key) do nothing;
alter table public.job_types enable row level security;
drop policy if exists job_types_read on public.job_types;
create policy job_types_read on public.job_types for select to authenticated using (true);

alter table public.jobs add column if not exists job_type text references public.job_types(key);
alter table public.jobs add column if not exists created_via text;
comment on column public.jobs.job_type is
  'Renew / Rehab / Yoak PM (job_types). Set by the app; when blank on insert, inferred from the name. A name containing "Yoak PM" always means yoak_pm.';
comment on column public.jobs.created_via is
  'How the job was created: manual (signed-in user), webhook (GHL opportunity), system (other server process). Blank on jobs created before 2026-11-18.';
create index if not exists jobs_job_type_idx on public.jobs (job_type);

create or replace function public.jobs_set_type_and_origin() returns trigger
language plpgsql security definer set search_path = public as $f$
declare v_pm text;
begin
  select key into v_pm from job_types
   where name_pattern is not null and active and coalesce(new.customer_name, '') ~* name_pattern
   order by sort limit 1;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.created_via := coalesce(new.created_via,
      case when auth.uid() is not null then 'manual'
           when new.ghl_opportunity_id is not null then 'webhook'
           else 'system' end);
    if new.job_type is null then
      new.job_type := coalesce(v_pm,
        case when coalesce(new.customer_name, '') ~ '^\s*\d+\s+\S' then 'rehab' else 'renew' end);
    end if;
  end if;
  if v_pm is not null then new.job_type := v_pm; end if;
  if new.job_type is null and tg_op = 'UPDATE' then new.job_type := old.job_type; end if;
  return new;
end $f$;
revoke execute on function public.jobs_set_type_and_origin() from public, anon, authenticated;

drop trigger if exists jobs_set_type_and_origin on public.jobs;
create trigger jobs_set_type_and_origin
  before insert or update of customer_name, job_type on public.jobs
  for each row execute function public.jobs_set_type_and_origin();

alter table public.reconciliation_changes drop constraint if exists reconciliation_changes_kind_check;
alter table public.reconciliation_changes add constraint reconciliation_changes_kind_check
  check (kind = any (array['contract','payment','signed_date','trade','ghl_project_type','job_created',
                           'status','flag','link','job_type']));

insert into public.reconciliation_changes (batch, job_id, job_number, kind, old_text, new_text, note)
select 'job_types_2026-11-18', id, number, 'job_type', null, t,
       'Job type set from the name: ' || coalesce(customer_name, '')
from (select id, number, customer_name,
             case when customer_name ~* 'yoak\s*pm' then 'yoak_pm'
                  when customer_name ~ '^\s*\d+\s+\S' then 'rehab' end t
        from public.jobs where job_type is null) x
where t is not null;

update public.jobs set job_type =
  case when customer_name ~* 'yoak\s*pm' then 'yoak_pm'
       when customer_name ~ '^\s*\d+\s+\S' then 'rehab'
       else 'renew' end
where job_type is null;

alter table public.jobs alter column job_type set not null;

create or replace function public.job_type_flags_refresh() returns int
language plpgsql security definer set search_path = public as $f$
declare v_n int;
begin
  insert into contract_flags (source, kind, ref, name, amount, detail, candidates, first_seen_at, last_seen_at)
  select 'tradedesk', 'project_id_missing', 'job:' || j.id,
         'JOB-' || j.number || ' ' || coalesce(j.customer_name, ''), j.contract_amount,
         jsonb_build_object('job_number', j.number, 'job_type', j.job_type, 'type_label', t.label,
                            'stage', j.stage, 'created_via', j.created_via),
         '[]'::jsonb, now(), now()
    from jobs j join job_types t on t.key = j.job_type and t.expects_project_id
   where coalesce(j.ghl_status, '') not in ('lost', 'abandoned')
     and nullif(trim(coalesce(j.ghl_project_display_id, '')), '') is null
  on conflict (kind, ref) do update
     set last_seen_at = now(), resolved_at = null, resolution = null,
         name = excluded.name, amount = excluded.amount, detail = excluded.detail;
  get diagnostics v_n = row_count;

  update contract_flags f
     set resolved_at = now(), resolution = 'Project ID entered, or the job no longer needs one'
   where f.kind = 'project_id_missing' and f.resolved_at is null
     and not exists (
       select 1 from jobs j join job_types t on t.key = j.job_type and t.expects_project_id
        where 'job:' || j.id = f.ref
          and coalesce(j.ghl_status, '') not in ('lost', 'abandoned')
          and nullif(trim(coalesce(j.ghl_project_display_id, '')), '') is null);
  return v_n;
end $f$;
revoke execute on function public.job_type_flags_refresh() from public, anon, authenticated;

create or replace function public.job_flags_digest(p_to text[] default array['itadmin@yoakproperties.com'::text])
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_open jsonb; v_n int;
begin
  perform public.job_type_flags_refresh();
  update contract_flags f set resolved_at = now(), resolution = 'Sales row linked to JOB-' || j.number
    from sales_log_rows s join jobs j on j.id = s.job_id
   where f.kind = 'sheet_no_job' and f.resolved_at is null and s.tab = 'Sales' and s.removed_at is null
     and coalesce(s.row_key, 'row:' || s.id) = f.ref;
  update contract_flags f set resolved_at = now(), resolution = 'linked to JOB-' || j.number
    from jobs j where f.kind = 'ghl_no_job' and f.resolved_at is null and j.ghl_opportunity_id = f.ref;

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', source, 'kind', kind, 'ref', ref, 'name', name, 'amount', amount,
           'detail', detail, 'candidates', candidates, 'first_seen_at', first_seen_at) order by first_seen_at), '[]'::jsonb),
         count(*)
    into v_open, v_n
    from contract_flags where resolved_at is null;

  if v_n = 0 then return jsonb_build_object('open', 0, 'queued', false); end if;
  insert into email_outbound (purpose, to_addresses, status, attempts, payload)
  values ('sync_flags', p_to, 'pending', 0, jsonb_build_object('flags', v_open, 'generated_at', now()));
  return jsonb_build_object('open', v_n, 'queued', true);
end $f$;

create or replace function public.report_booked_by_type(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $f$
declare
  v_from date := date_trunc('month', coalesce(p_from,
                   (date_trunc('month', now() at time zone 'America/New_York') - interval '11 months')::date))::date;
  v_to date := coalesce(p_to, (now() at time zone 'America/New_York')::date);
  v jsonb;
begin
  if not public.is_admin() then raise exception 'reports are office-only' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'report end is before its start' using errcode = '22023'; end if;
  with months as (
    select gs::date m from generate_series(v_from::timestamp, date_trunc('month', v_to::timestamp), interval '1 month') gs),
  live as (
    select * from jobs
     where coalesce(ghl_status, '') not in ('lost', 'abandoned') and coalesce(flag, '') <> 'on_hold'
       and contract_signed_date between v_from and v_to),
  cells as (
    select date_trunc('month', l.contract_signed_date)::date m, l.job_type,
           sum(coalesce(l.contract_amount, 0)) booked, count(*) jobs
      from live l group by 1, 2)
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'types', (select jsonb_agg(jsonb_build_object('key', key, 'label', label) order by sort) from job_types where active),
    'months', (select jsonb_agg(jsonb_build_object(
        'month', mo.m,
        'booked', coalesce((select sum(booked) from cells c where c.m = mo.m), 0),
        'jobs', coalesce((select sum(jobs) from cells c where c.m = mo.m), 0),
        'by_type', coalesce((select jsonb_object_agg(c.job_type, jsonb_build_object('booked', c.booked, 'jobs', c.jobs))
                               from cells c where c.m = mo.m), '{}'::jsonb)) order by mo.m) from months mo),
    'totals', jsonb_build_object(
        'booked', coalesce((select sum(booked) from cells), 0),
        'jobs', coalesce((select sum(jobs) from cells), 0),
        'by_type', coalesce((select jsonb_object_agg(job_type, jsonb_build_object('booked', b, 'jobs', n))
                               from (select job_type, sum(booked) b, sum(jobs) n from cells group by 1) t), '{}'::jsonb)))
    into v;
  return v;
end $f$;
revoke execute on function public.report_booked_by_type(date, date) from public, anon;
grant execute on function public.report_booked_by_type(date, date) to authenticated;;
