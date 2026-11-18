create or replace view public.job_financials as
select j.id as job_id, j.number, j.customer_name, j.trade, j.trades, j.is_repair, j.stage, j.substage, j.flag,
  coalesce(j.flag = 'on_hold', false) as on_hold, j.ghl_status, j.contract_amount,
  coalesce(cp.received, 0::numeric) as client_received,
  j.contract_amount - coalesce(cp.credits, 0::numeric) - coalesce(cp.received, 0::numeric) as balance_due,
  (j.contract_amount - coalesce(cp.credits, 0::numeric)) > 0::numeric and coalesce(cp.received, 0::numeric) >= (j.contract_amount - coalesce(cp.credits, 0::numeric)) as paid_in_full,
  coalesce(vp.paid, 0::numeric) as vendor_paid, coalesce(vp.pending, 0::numeric) as vendor_pending,
  coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) as vendor_total,
  (j.contract_amount - coalesce(cp.credits, 0::numeric)) - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric)) as margin,
  case when (j.contract_amount - coalesce(cp.credits, 0::numeric)) > 0::numeric
    then round(((j.contract_amount - coalesce(cp.credits, 0::numeric)) - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric))) / (j.contract_amount - coalesce(cp.credits, 0::numeric)), 4)
    else 0::numeric end as margin_pct,
  j.start_date, j.target_date, j.ghl_project_display_id,
  coalesce(cp.credits, 0::numeric) as client_credits,
  j.contract_amount - coalesce(cp.credits, 0::numeric) as net_contract
from jobs j
left join lateral (select sum(c.amount) filter (where not coalesce(pt.is_credit, false)) as received,
                          sum(c.amount) filter (where pt.is_credit) as credits
                   from client_payments c left join payment_types pt on pt.key = c.payment_type
                   where c.job_id = j.id) cp on true
left join lateral (select sum(v.amount) filter (where v.status = 'paid') as paid,
                          sum(v.amount) filter (where v.status = 'pending') as pending
                   from vendor_payments v where v.job_id = j.id) vp on true;;
