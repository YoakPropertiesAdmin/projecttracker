-- TradeDesk -> GHL write-back.
--
-- Which TradeDesk stage pushes which GHL stage is a table, not code, so
-- changing the policy is one row rather than a redeploy.
--
-- Seeded with 'closed' (TradeDesk's "Closed / Paid") only, NOT 'completed'.
-- 'completed' is fed by the GHL stage "Needs Collected", which means the work
-- is done but the money is not in. Firing the review request there would ask
-- for a review while still chasing a balance.

create table if not exists public.ghl_writeback_targets (
  td_stage        text primary key,
  ghl_stage_name  text not null,
  set_status      text,          -- null = leave the opportunity's status alone
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on column public.ghl_writeback_targets.set_status is
  'Optional GHL opportunity status to set alongside the stage move. Left null so a stage move does not silently mark an opportunity won or lost.';

insert into public.ghl_writeback_targets (td_stage, ghl_stage_name)
values ('closed', 'Project Complete')
on conflict (td_stage) do nothing;

create table if not exists public.ghl_outbound (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references public.jobs(id) on delete cascade,
  opportunity_id     text not null,
  target_stage_name  text not null,
  set_status         text,
  reason             text,
  status             text not null default 'pending'
                     check (status in ('pending','sent','skipped','failed')),
  attempts           int  not null default 0,
  last_error         text,
  note               text,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);

comment on table public.ghl_outbound is
  'Queue of stage moves TradeDesk owes GoHighLevel. A queue rather than a direct call so a CRM outage retries instead of losing the move.';

-- One outstanding move per job per target; a second stage change while one is
-- still queued updates the existing row rather than stacking duplicates.
create unique index if not exists ghl_outbound_pending_uniq
  on public.ghl_outbound (job_id, target_stage_name) where status = 'pending';
create index if not exists ghl_outbound_status_idx
  on public.ghl_outbound (status, created_at);

alter table public.ghl_outbound enable row level security;
alter table public.ghl_writeback_targets enable row level security;

drop policy if exists ghl_outbound_read on public.ghl_outbound;
create policy ghl_outbound_read on public.ghl_outbound
  for select to authenticated using (true);

drop policy if exists ghl_writeback_targets_read on public.ghl_writeback_targets;
create policy ghl_writeback_targets_read on public.ghl_writeback_targets
  for select to authenticated using (true);;
