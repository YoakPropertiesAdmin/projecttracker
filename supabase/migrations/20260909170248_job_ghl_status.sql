-- GHL's own opportunity status, distinct from the board stage. The sweep will
-- manage Open jobs; a job that becomes Lost or Abandoned stops being live but
-- is kept, because the history and any money already collected still matter.
alter table public.jobs
  add column if not exists ghl_status text not null default 'open'
    check (ghl_status in ('open','won','lost','abandoned'));

create index if not exists idx_jobs_ghl_status on public.jobs (ghl_status) where ghl_status <> 'open';

-- Everything already in the tracker predates the status sync and is kept as
-- history: jobs the office has closed out are marked won, the rest stay open.
update public.jobs set ghl_status = 'won' where stage = 'closed' and ghl_status = 'open';

comment on column public.jobs.ghl_status is
  'Opportunity status in GoHighLevel. open = live and managed by the sweep; won/lost/abandoned are kept as history.';

drop view if exists public.job_financials;
create view public.job_financials
with (security_invoker = on) as
select
  j.id as job_id, j.number, j.customer_name,
  j.trade, j.trades, j.is_repair, j.stage, j.substage,
  j.flag, coalesce(j.flag = 'on_hold', false) as on_hold, j.ghl_status,
  j.contract_amount,
  coalesce(cp.received, 0)                       as client_received,
  j.contract_amount - coalesce(cp.received, 0)   as balance_due,
  (j.contract_amount > 0 and coalesce(cp.received, 0) >= j.contract_amount) as paid_in_full,
  coalesce(vp.paid, 0)                           as vendor_paid,
  coalesce(vp.pending, 0)                        as vendor_pending,
  coalesce(vp.paid, 0) + coalesce(vp.pending, 0) as vendor_total,
  j.contract_amount - (coalesce(vp.paid, 0) + coalesce(vp.pending, 0)) as margin,
  case when j.contract_amount > 0
    then round((j.contract_amount - (coalesce(vp.paid,0) + coalesce(vp.pending,0))) / j.contract_amount, 4)
    else 0 end                                   as margin_pct,
  j.start_date, j.target_date, j.ghl_project_display_id
from public.jobs j
left join lateral (
  select sum(amount) as received from public.client_payments c where c.job_id = j.id
) cp on true
left join lateral (
  select sum(amount) filter (where status = 'paid')    as paid,
         sum(amount) filter (where status = 'pending') as pending
  from public.vendor_payments v where v.job_id = j.id
) vp on true;

select ghl_status, count(*) from public.jobs group by ghl_status;;
