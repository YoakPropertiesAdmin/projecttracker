-- Stage answers "where is this job"; these two answer "what else is true about
-- it". Keeping them separate is what lets nine GHL stages map onto eight board
-- columns without losing the distinction between Ordered and Materials In, or
-- silently turning a stalled contract into a fresh one.
alter table public.jobs
  -- The GHL stage name as sent, e.g. 'Materials In'. Shown as a chip on the
  -- card so the board column stays coarse and the detail stays visible.
  add column if not exists substage text,
  -- An exception state, not a step: a held job sits in its stage and gets a
  -- warning marker. Set from GHL, and toggleable by the office for jobs that
  -- never came from GHL.
  add column if not exists on_hold boolean not null default false;

create index if not exists idx_jobs_on_hold on public.jobs (on_hold) where on_hold;

-- Rebuilt rather than replaced: CREATE OR REPLACE VIEW cannot insert columns
-- into the middle of an existing view's column list.
drop view if exists public.job_financials;

create view public.job_financials
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
  j.start_date, j.target_date
from public.jobs j
left join lateral (
  select sum(amount) as received from public.client_payments c where c.job_id = j.id
) cp on true
left join lateral (
  select sum(amount) filter (where status = 'paid')    as paid,
         sum(amount) filter (where status = 'pending') as pending
  from public.vendor_payments v where v.job_id = j.id
) vp on true;

comment on view public.job_financials is
  'Per-job money rollup plus stage/substage/hold. Mirrors the derivations in src/App.jsx.';;
