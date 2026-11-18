-- on_hold was a single boolean; the office needs the same treatment for two
-- more states. Rather than a boolean per marker, one nullable flag with a
-- registry behind it — a fourth marker later is one row, not a schema change
-- and a redeploy.
create table if not exists public.job_flags (
  key        text primary key,
  label      text not null,
  icon       text not null default 'alerttriangle',  -- lucide name, resolved in the app
  color      text not null default '#B07D12',        -- the corner marker
  tint       text,                                   -- card wash; only for states that should stop the eye
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

alter table public.job_flags enable row level security;
revoke all on public.job_flags from anon;
drop policy if exists job_flags_read on public.job_flags;
create policy job_flags_read on public.job_flags for select to authenticated using (true);
drop policy if exists job_flags_write on public.job_flags;
create policy job_flags_write on public.job_flags for all to authenticated using (true) with check (true);

-- Only 'on hold' tints the whole card: it is an exception state and a stalled
-- job should look stalled. The other two are progress detail, so they get a
-- corner marker and otherwise leave the card alone.
insert into public.job_flags (key, label, icon, color, tint, sort_order) values
  ('on_hold',       'On hold',       'alerttriangle', '#B07D12', '#FDF7EA', 10),
  ('materials_in',  'Materials in',  'packagecheck',  '#3E6B3A', null,      20),
  ('needs_ordered', 'Needs ordered', 'shoppingcart',  '#4A5480', null,      30)
on conflict (key) do update set
  label = excluded.label, icon = excluded.icon, color = excluded.color,
  tint = excluded.tint, sort_order = excluded.sort_order;

alter table public.jobs add column if not exists flag text references public.job_flags(key) on delete set null;
update public.jobs set flag = 'on_hold' where on_hold and flag is null;
create index if not exists idx_jobs_flag on public.jobs (flag) where flag is not null;

-- A GHL stage can now set both the board column and the marker.
alter table public.ghl_stage_map add column if not exists flag text references public.job_flags(key) on delete set null;
update public.ghl_stage_map set flag = 'on_hold'       where ghl_stage_name = 'contract on hold';
update public.ghl_stage_map set flag = 'materials_in'  where ghl_stage_name = 'materials in';
update public.ghl_stage_map set flag = 'needs_ordered' where ghl_stage_name = 'needs ordered';

-- on_hold stays as a derived column so existing reporting queries keep working
-- while there is exactly one source of truth underneath.
drop view if exists public.job_financials;
create view public.job_financials
with (security_invoker = on) as
select
  j.id as job_id, j.number, j.customer_name,
  j.trade, j.trades, j.is_repair, j.stage, j.substage,
  j.flag, (j.flag = 'on_hold') as on_hold,
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
  j.start_date, j.target_date, j.ghl_project_display_id, j.expected_final_payment
from public.jobs j
left join lateral (
  select sum(amount) as received from public.client_payments c where c.job_id = j.id
) cp on true
left join lateral (
  select sum(amount) filter (where status = 'paid')    as paid,
         sum(amount) filter (where status = 'pending') as pending
  from public.vendor_payments v where v.job_id = j.id
) vp on true;

alter table public.jobs drop column if exists on_hold;;
