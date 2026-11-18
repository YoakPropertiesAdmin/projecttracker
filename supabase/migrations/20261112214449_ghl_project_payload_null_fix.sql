create or replace function public.ghl_project_object_payloads(p_projects text[] default null)
returns table(project_number text, contact_id text, job_ids uuid[], first_job uuid, props jsonb)
language sql security definer set search_path = public as $f$
with j as (
  select *, nullif(regexp_replace(coalesce(ghl_project_display_id,''), '\D', '', 'g'), '') pn,
         coalesce(ghl_status,'') in ('lost','abandoned') dead,
         coalesce(stage,'') st, coalesce(paid_status,'') ps
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
    'budget', coalesce(sum(g.contract_amount) filter (where not g.dead), 0),
    'start_date', min(g.contract_signed_date),
    'project_status', case
        when bool_and(g.dead) then 'cancelled'
        when bool_or(not g.dead and coalesce(g.flag,'') = 'on_hold') then 'on_hold'
        when bool_and(g.dead or g.st in ('completed','closed')) then 'completed'
        when bool_or(not g.dead and g.st in ('scheduled','in_progress','punch_list','completed','closed')) then 'in_progress'
        else 'planned' end,
    'payment_status', case
        when bool_and(g.dead or g.ps = 'completed') then 'paid'
        when bool_or(g.ps in ('completed','in_progress')) then 'pending'
        else 'unpaid' end
  ))
from g group by g.pn;
$f$;
revoke all on function public.ghl_project_object_payloads(text[]) from public, anon, authenticated;
grant execute on function public.ghl_project_object_payloads(text[]) to service_role;;
