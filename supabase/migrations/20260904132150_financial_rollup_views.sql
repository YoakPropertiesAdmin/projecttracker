-- The app derives balance due, vendor exposure and margin in JavaScript.
-- These views compute the identical numbers in the database so anything else
-- that needs them — a QuickBooks reconciliation, an ownership dashboard, a
-- plain SQL query — reads one definition instead of re-implementing the math.
--
-- security_invoker = on means the views obey the same RLS as their base
-- tables: still authenticated-only, no privilege escalation through a view.

create or replace view public.job_financials
with (security_invoker = on) as
select
  j.id                as job_id,
  j.number,
  j.customer_name,
  j.trade,
  j.stage,
  j.contract_amount,
  coalesce(cp.received, 0)                              as client_received,
  j.contract_amount - coalesce(cp.received, 0)          as balance_due,
  coalesce(vp.paid, 0)                                  as vendor_paid,
  coalesce(vp.pending, 0)                               as vendor_pending,
  coalesce(vp.paid, 0) + coalesce(vp.pending, 0)        as vendor_total,
  j.contract_amount - (coalesce(vp.paid, 0) + coalesce(vp.pending, 0)) as margin,
  case
    when j.contract_amount > 0
      then round((j.contract_amount - (coalesce(vp.paid, 0) + coalesce(vp.pending, 0))) / j.contract_amount, 4)
    else 0
  end                                                   as margin_pct,
  j.start_date,
  j.target_date
from public.jobs j
left join lateral (
  select sum(amount) as received
  from public.client_payments c
  where c.job_id = j.id
) cp on true
left join lateral (
  select
    sum(amount) filter (where status = 'paid')    as paid,
    sum(amount) filter (where status = 'pending') as pending
  from public.vendor_payments v
  where v.job_id = j.id
) vp on true;

-- Spend per vendor, keyed on the name the payment was booked under — which is
-- how the Vendors screen rolls it up, and which keeps history intact for a
-- vendor that has since been deleted from the directory.
create or replace view public.vendor_rollup
with (security_invoker = on) as
select
  vp.vendor_name,
  max(vp.vendor_id::text)::uuid                          as vendor_id,
  sum(vp.amount) filter (where vp.status = 'paid')       as paid,
  sum(vp.amount) filter (where vp.status = 'pending')    as pending,
  sum(vp.amount)                                         as total,
  count(distinct vp.job_id)                              as job_count,
  max(vp.payment_date)                                   as last_activity
from public.vendor_payments vp
group by vp.vendor_name;

comment on view public.job_financials is
  'Per-job money rollup: client received, balance due, vendor paid/pending, margin. Mirrors the derivations in src/App.jsx.';
comment on view public.vendor_rollup is
  'Per-vendor spend keyed on the payment name snapshot, so deleted vendors keep their history.';;
