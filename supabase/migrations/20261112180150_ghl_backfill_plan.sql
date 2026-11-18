create table if not exists public.ghl_backfill_plan (
  id bigserial primary key,
  run_id text not null,
  job_id uuid,
  job_number bigint,
  opportunity_id text,
  contact_id text,
  item text not null,
  action text not null,
  td_value text,
  ghl_value text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ghl_backfill_plan_run on public.ghl_backfill_plan(run_id, item, action);
alter table public.ghl_backfill_plan enable row level security;
comment on table public.ghl_backfill_plan is 'Dry-run plans for TradeDesk -> GHL backfills (written by td-crm-admin backfill_dry_run). Service role only.';;
