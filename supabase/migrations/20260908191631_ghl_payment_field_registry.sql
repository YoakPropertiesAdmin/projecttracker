-- Each GHL payment field becomes a real ledger row. A registry rather than
-- three hardcoded branches, so a third deposit is one INSERT here instead of a
-- migration and a redeploy — and rows can be pre-registered before the field
-- exists in GHL, staying inert until it starts arriving.
create table if not exists public.ghl_payment_fields (
  payload_key text primary key,     -- exactly as GHL flattens it
  source_ref  text not null unique, -- ties the ledger row to this field
  label       text not null,        -- shown on the payment row
  method      text not null default 'Unknown',
  sort_order  integer not null default 100,
  active      boolean not null default true
);

alter table public.ghl_payment_fields enable row level security;
revoke all on public.ghl_payment_fields from anon;
drop policy if exists ghl_payment_fields_read on public.ghl_payment_fields;
create policy ghl_payment_fields_read on public.ghl_payment_fields
  for select to authenticated using (true);

insert into public.ghl_payment_fields (payload_key, source_ref, label, sort_order) values
  ('opportunity initial deposit', 'ghl:initial_deposit', 'Initial deposit',  10),
  ('opportunity second deposit',  'ghl:second_deposit',  'Second deposit',   20),
  ('opportunity final payment',   'ghl:final_payment',   'Final payment',    30)
on conflict (payload_key) do update
  set source_ref = excluded.source_ref, label = excluded.label, sort_order = excluded.sort_order;

-- Carry the one existing GHL deposit row onto its new source_ref.
update public.client_payments set source_ref = 'ghl:initial_deposit' where source_ref = 'ghl:deposit';

-- Applies every registered payment field for one job: writes a row for each
-- value present, updates it when the CRM value changes, and removes it when the
-- value is cleared in the CRM. Keyed on (job_id, source_ref), so a redelivery
-- can never duplicate. Payments entered directly in TradeDesk have a null
-- source_ref and are never touched by this.
create or replace function public.ghl_apply_payments(p_job_id uuid, p_payload jsonb, p_when timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f      record;
  v_amt  numeric;
  applied jsonb := '[]'::jsonb;
  removed jsonb := '[]'::jsonb;
begin
  for f in select * from public.ghl_payment_fields where active order by sort_order loop
    v_amt := public.ghl_money(p_payload, f.payload_key);

    if v_amt is not null and v_amt > 0 then
      insert into public.client_payments (job_id, amount, payment_date, method, note, source_ref)
      values (p_job_id, v_amt, p_when, f.method,
              'ADDED BY GHL — ' || f.label, f.source_ref)
      on conflict (job_id, source_ref) where source_ref is not null
      do update set amount = excluded.amount, note = excluded.note;
      applied := applied || jsonb_build_object('label', f.label, 'amount', v_amt);
    else
      -- Cleared or zeroed in the CRM: the payment did not happen, so the row
      -- should not survive. Only ever removes rows this integration created.
      delete from public.client_payments
       where job_id = p_job_id and source_ref = f.source_ref;
    end if;
  end loop;

  return jsonb_build_object('applied', applied);
end;
$$;

revoke execute on function public.ghl_apply_payments(uuid, jsonb, timestamptz) from public, anon, authenticated;

-- `final payment` is money received, not a schedule, so the column that stored
-- it as an expectation is obsolete.
drop view if exists public.job_financials;
alter table public.jobs drop column if exists expected_final_payment;

create view public.job_financials
with (security_invoker = on) as
select
  j.id as job_id, j.number, j.customer_name,
  j.trade, j.trades, j.is_repair, j.stage, j.substage,
  j.flag, coalesce(j.flag = 'on_hold', false) as on_hold,
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
) vp on true;;
