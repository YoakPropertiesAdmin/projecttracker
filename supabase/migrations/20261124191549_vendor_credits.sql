-- Vendor credits (2026-11-24): money a vendor takes back off a job's cost
-- after the bill was booked (credit memo, returned materials, price fix).
-- Lowers the job's vendor cost; never cash, never a vendor payment.

create table if not exists public.vendor_credits (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  vendor_name text not null,
  amount numeric(12,2) not null check (amount > 0),
  credit_date timestamptz not null default now(),
  reason text not null default '',
  settlement text not null default 'on_account' check (settlement in ('open_bill', 'on_account', 'refund')),
  vendor_payment_id uuid references public.vendor_payments(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);
comment on table public.vendor_credits is 'Money a vendor takes back off a job''s cost after the bill was booked. Lowers vendor cost (job_financials.vendor_total is net of these). Not cash and not a vendor payment. settlement: open_bill = lowers an unpaid bill (vendor_payment_id), on_account = credit with the vendor for a future invoice, refund = vendor sends a check (still reported as a credit, not cash).';
create index if not exists vendor_credits_job_id_idx on public.vendor_credits(job_id);
create index if not exists vendor_credits_vendor_id_idx on public.vendor_credits(vendor_id);
create index if not exists vendor_credits_vendor_payment_id_idx on public.vendor_credits(vendor_payment_id);

alter table public.vendor_credits enable row level security;
create policy vendor_credits_admin_read on public.vendor_credits for select to authenticated using (public.is_admin());
create policy vendor_credits_admin_insert on public.vendor_credits for insert to authenticated with check (public.is_admin());
create policy vendor_credits_admin_update on public.vendor_credits for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy vendor_credits_admin_delete on public.vendor_credits for delete to authenticated using (public.is_admin());
revoke all on public.vendor_credits from anon;
grant select, insert, update, delete on public.vendor_credits to authenticated;

-- job_financials: vendor_total is now NET of vendor credits, so margin, the
-- scorecard and finalize_job_gp (which all read vendor_total / margin) follow
-- with no further edits. vendor_paid / vendor_pending stay the gross bills;
-- vendor_gross and vendor_credits are appended.
create or replace view public.job_financials with (security_invoker = true) as
select j.id as job_id, j.number, j.customer_name, j.trade, j.trades, j.is_repair, j.stage, j.substage, j.flag,
  coalesce(j.flag = 'on_hold', false) as on_hold, j.ghl_status, j.contract_amount,
  coalesce(cp.received, 0::numeric) as client_received,
  j.contract_amount - coalesce(cp.received, 0::numeric) - coalesce(cc.credits, 0::numeric) as balance_due,
  j.contract_amount > 0::numeric and coalesce(cp.received, 0::numeric) + coalesce(cc.credits, 0::numeric) >= j.contract_amount as paid_in_full,
  coalesce(vp.paid, 0::numeric) as vendor_paid,
  coalesce(vp.pending, 0::numeric) as vendor_pending,
  coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) - coalesce(vc.credits, 0::numeric) as vendor_total,
  (j.contract_amount - coalesce(cc.credits, 0::numeric))
    - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) - coalesce(vc.credits, 0::numeric)) as margin,
  case when (j.contract_amount - coalesce(cc.credits, 0::numeric)) > 0::numeric
    then round(((j.contract_amount - coalesce(cc.credits, 0::numeric))
                - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) - coalesce(vc.credits, 0::numeric)))
               / (j.contract_amount - coalesce(cc.credits, 0::numeric)), 4)
    else 0::numeric end as margin_pct,
  j.start_date, j.target_date, j.ghl_project_display_id,
  coalesce(cc.credits, 0::numeric) as client_credits,
  j.contract_amount - coalesce(cc.credits, 0::numeric) as net_contract,
  coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) as vendor_gross,
  coalesce(vc.credits, 0::numeric) as vendor_credits
from jobs j
left join lateral (select sum(c.amount) as received from client_payments c where c.job_id = j.id) cp on true
left join lateral (select sum(k.amount) as credits from client_credits k where k.job_id = j.id) cc on true
left join lateral (select sum(v.amount) filter (where v.status = 'paid') as paid,
                          sum(v.amount) filter (where v.status = 'pending') as pending
                   from vendor_payments v where v.job_id = j.id) vp on true
left join lateral (select sum(x.amount) as credits from vendor_credits x where x.job_id = j.id) vc on true;
comment on column public.job_financials.vendor_total is 'Net vendor cost: paid + pending bills minus vendor credits. Margin uses this.';
comment on column public.job_financials.vendor_gross is 'Vendor bills before credits (paid + pending).';
comment on column public.job_financials.vendor_credits is 'Sum of vendor_credits on the job.';

-- Finalization snapshot records the credits too (vendor_total in it is net).
alter table public.job_finalizations add column if not exists vendor_credits numeric not null default 0;

do $d$
declare s text; n text;
begin
  s := pg_get_functiondef('public.finalize_job_gp(uuid)'::regprocedure);
  n := replace(s,
    'vendor_total, margin, margin_pct, prior_margin, finalized_by) values (p_job, v_seq, f.net_contract, f.client_received, f.vendor_paid, f.vendor_pending, f.vendor_total, f.margin,',
    'vendor_total, vendor_credits, margin, margin_pct, prior_margin, finalized_by) values (p_job, v_seq, f.net_contract, f.client_received, f.vendor_paid, f.vendor_pending, f.vendor_total, f.vendor_credits, f.margin,');
  if n = s then raise exception 'finalize_job_gp: insert not matched'; end if;
  execute n;

  s := pg_get_functiondef('public.job_status_preview'::regproc);
  n := replace(s,
    '''credit_total'', (select coalesce(sum(amount), 0) from client_credits where job_id = p_job),',
    '''credit_total'', (select coalesce(sum(amount), 0) from client_credits where job_id = p_job),
    ''vendor_credit_total'', (select coalesce(sum(amount), 0) from vendor_credits where job_id = p_job),
    ''vendor_credit_count'', (select count(*) from vendor_credits where job_id = p_job),');
  if n = s then raise exception 'job_status_preview: not matched'; end if;
  execute n;
end $d$;

-- vendor_rollup: keep the original columns (total = gross bills), append
-- credits and net.
create or replace view public.vendor_rollup with (security_invoker = on) as
select vendor_name,
  (max(vendor_id::text))::uuid as vendor_id,
  sum(amount) filter (where kind = 'bill' and status = 'paid') as paid,
  sum(amount) filter (where kind = 'bill' and status = 'pending') as pending,
  sum(amount) filter (where kind = 'bill') as total,
  count(distinct job_id) as job_count,
  max(at) as last_activity,
  coalesce(sum(amount) filter (where kind = 'credit'), 0) as credits,
  coalesce(sum(amount) filter (where kind = 'bill'), 0) - coalesce(sum(amount) filter (where kind = 'credit'), 0) as net
from (
  select 'bill' as kind, vendor_name, vendor_id, job_id, amount, status, payment_date as at from public.vendor_payments
  union all
  select 'credit', vendor_name, vendor_id, job_id, amount, null, credit_date from public.vendor_credits
) x
group by vendor_name;

-- Job #1102: two client credits were logged as vendor costs under a made-up
-- vendor "Client Credit" before Client Credits existed. Move them to
-- client_credits. Margin is unchanged; balance due becomes right.
with moved as (
  delete from public.vendor_payments vp
   using public.jobs j
   where j.id = vp.job_id and j.number = 1102 and vp.vendor_name = 'Client Credit'
  returning vp.job_id, vp.amount, vp.payment_date
)
insert into public.client_credits (job_id, amount, credit_date, reason, created_by)
select job_id, amount, payment_date, 'Client credit (moved from vendor costs, 2026-11-24)', null from moved;
