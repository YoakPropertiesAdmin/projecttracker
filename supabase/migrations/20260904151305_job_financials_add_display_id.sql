-- Appended at the end: CREATE OR REPLACE VIEW allows adding columns to the tail
-- of the list, just not inserting them in the middle.
create or replace view public.job_financials
with (security_invoker = on) as
select
  j.id as job_id, j.number, j.customer_name, j.trade, j.stage, j.substage, j.on_hold,
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
  j.start_date, j.target_date,
  j.ghl_project_display_id,
  j.expected_final_payment
from public.jobs j
left join lateral (
  select sum(amount) as received from public.client_payments c where c.job_id = j.id
) cp on true
left join lateral (
  select sum(amount) filter (where status = 'paid')    as paid,
         sum(amount) filter (where status = 'pending') as pending
  from public.vendor_payments v where v.job_id = j.id
) vp on true;;
