create table if not exists public.ghl_object_links (
  kind text not null,            -- 'job' | 'project' | 'relation'
  td_key text not null,          -- job id | project number | association|first|second
  record_id text,
  payload_hash text,
  synced_at timestamptz,
  error text,
  primary key (kind, td_key)
);
alter table public.ghl_object_links enable row level security;
comment on table public.ghl_object_links is 'TradeDesk job/project -> GHL Jobs/Projects custom-object record ids, and created relations. Service role only.';

create or replace function public.ghl_job_object_payloads(p_numbers bigint[] default null)
returns table(job_id uuid, number bigint, opportunity_id text, contact_id text, project_number text, props jsonb)
language sql security definer set search_path = public as $f$
with j as (
  select * from jobs where ghl_opportunity_id is not null and (p_numbers is null or number = any(p_numbers))
),
asg as (
  select a.job_id,
    string_agg(distinct s.name, ', ') filter (where a.role = 'project_manager') pm,
    string_agg(distinct s.name, ', ') filter (where a.role = 'installer') inst,
    min(a.start_date) filter (where a.role = 'installer') inst_start
  from job_assignments a join assignees s on s.id = a.assignee_id
  where a.job_id in (select id from j) group by a.job_id
),
cl as (
  select distinct on (c.job_id) c.job_id, nullif(c.project_manager,'') pm, nullif(c.installer,'') inst, c.date_started
  from completion_log_rows c where c.job_id in (select id from j) and c.removed_at is null
  order by c.job_id, c.updated_at desc nulls last
),
cd as (select d.job_id, d.completed_at from job_completion_dates() d)
select j.id, j.number, j.ghl_opportunity_id, j.ghl_contact_id,
  nullif(regexp_replace(coalesce(j.ghl_project_display_id,''), '\D', '', 'g'), ''),
  jsonb_strip_nulls(jsonb_build_object(
    'job_name', j.customer_name,
    'job_number', 'JOB-' || j.number,
    'address', nullif(j.customer_address, ''),
    'price', j.contract_amount,
    'scheduled_date', coalesce(asg.inst_start, cl.date_started)::date,
    'completion_date', cd.completed_at::date,
    'job_status', case
        when j.ghl_status in ('lost','abandoned') then 'cancelled'
        when j.stage = 'signed' then 'contract_signed'
        when j.stage in ('closed','completed') then 'completed'
        when j.stage in ('permitting','materials_ordered','scheduled','in_progress','punch_list') then j.stage
        else null end,
    'service_type', case
        when j.is_repair and (j.trades is null or j.trades <@ array['other']) then 'pest_control'
        when 'roofing' = any(j.trades) then 'roofing'
        when 'siding' = any(j.trades) then 'hvac'
        when 'windows' = any(j.trades) then 'electrical'
        when 'doors' = any(j.trades) then 'cleaning'
        when 'gutters' = any(j.trades) then 'landscaping'
        when 'soffit_fascia' = any(j.trades) then 'soffit__fascia__trim'
        else 'other' end,
    'trades', (select jsonb_agg(t order by t) from (
        select unnest(case when j.trades && array['combo'] then array_remove(j.trades,'combo') else j.trades end) t
        union select 'repair' where j.is_repair) x where t in ('roofing','siding','windows','doors','gutters','soffit_fascia','other','repair')),
    'project_manager', coalesce(asg.pm, cl.pm),
    'installer', coalesce(asg.inst, cl.inst),
    'payment_status', case j.paid_status when 'completed' then 'paid' when 'in_progress' then 'pending' else 'unpaid' end,
    'opportunity_id', j.ghl_opportunity_id
  ))
from j left join asg on asg.job_id = j.id left join cl on cl.job_id = j.id left join cd on cd.job_id = j.id;
$f$;

create or replace function public.ghl_project_object_payloads(p_projects text[] default null)
returns table(project_number text, contact_id text, job_ids uuid[], first_job uuid, props jsonb)
language sql security definer set search_path = public as $f$
with j as (
  select *, nullif(regexp_replace(coalesce(ghl_project_display_id,''), '\D', '', 'g'), '') pn
  from jobs where ghl_opportunity_id is not null
),
g as (select * from j where pn is not null and (p_projects is null or pn = any(p_projects)))
select g.pn,
  (array_agg(g.ghl_contact_id order by g.contract_signed_date nulls last, g.number) filter (where g.ghl_contact_id is not null))[1],
  array_agg(g.id order by g.number),
  (array_agg(g.id order by g.contract_signed_date nulls last, g.number))[1],
  jsonb_strip_nulls(jsonb_build_object(
    'project_name', (array_agg(g.customer_name order by g.contract_signed_date nulls last, g.number))[1],
    'project_number', g.pn,
    'project_address', (array_agg(nullif(g.customer_address,'') order by g.contract_signed_date nulls last, g.number))[1],
    'budget', coalesce(sum(g.contract_amount) filter (where coalesce(g.ghl_status,'') not in ('lost','abandoned')), 0),
    'start_date', min(g.contract_signed_date),
    'project_status', case
        when bool_and(coalesce(g.ghl_status,'') in ('lost','abandoned')) then 'cancelled'
        when bool_or(g.flag = 'on_hold' and coalesce(g.ghl_status,'') not in ('lost','abandoned')) then 'on_hold'
        when bool_and(coalesce(g.ghl_status,'') in ('lost','abandoned') or g.stage in ('completed','closed')) then 'completed'
        when bool_or(coalesce(g.ghl_status,'') not in ('lost','abandoned') and g.stage in ('scheduled','in_progress','punch_list','completed','closed')) then 'in_progress'
        else 'planned' end,
    'payment_status', case
        when bool_and(coalesce(g.ghl_status,'') in ('lost','abandoned') or g.paid_status = 'completed') then 'paid'
        when bool_or(g.paid_status in ('completed','in_progress')) then 'pending'
        else 'unpaid' end
  ))
from g group by g.pn;
$f$;

revoke all on function public.ghl_job_object_payloads(bigint[]) from public, anon, authenticated;
revoke all on function public.ghl_project_object_payloads(text[]) from public, anon, authenticated;
grant execute on function public.ghl_job_object_payloads(bigint[]) to service_role;
grant execute on function public.ghl_project_object_payloads(text[]) to service_role;;
