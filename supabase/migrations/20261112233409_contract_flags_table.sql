comment on table public.job_flags is 'Registry of job flags (e.g. On hold): key, label, icon, colors, sort order, demote.';
comment on policy job_flags_admin_read on public.job_flags is 'Added 2026-11-12 by mistake (name collision); redundant with job_flags_read, grants nothing extra. Safe to drop.';

create table if not exists public.contract_flags (
  id uuid primary key default gen_random_uuid(),
  source text not null,              -- ghl_sweep | ghl_webhook | ghl_workflow | sales_sheet
  kind text not null,                -- ghl_no_job | sheet_no_job
  ref text not null,                 -- opportunity id | sheet row key
  name text, amount numeric,
  detail jsonb, candidates jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz, resolution text,
  unique (kind, ref)
);
alter table public.contract_flags enable row level security;
create policy contract_flags_admin_read on public.contract_flags for select to authenticated using (public.is_admin());
comment on table public.contract_flags is 'Contracts (GHL opportunities, Sales-sheet rows) with no TradeDesk job. Only the GHL app webhook creates jobs automatically; the sweep, old workflow and sheet sync flag here. Auto-resolves when linked; morning email via job_flags_digest().';;
