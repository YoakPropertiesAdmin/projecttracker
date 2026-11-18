create table if not exists public.reconciliation_changes (id bigint generated always as identity primary key, batch text not null, job_id uuid not null references public.jobs(id) on delete cascade, job_number bigint, kind text not null check (kind in ('contract','payment')), old_amount numeric, new_amount numeric, payment_id uuid, note text, created_at timestamptz not null default now());
alter table public.reconciliation_changes enable row level security;
create policy reconciliation_changes_admin_read on public.reconciliation_changes for select using (public.is_admin());
comment on table public.reconciliation_changes is 'Audit/undo log for bulk data corrections. contract rows hold old/new contract_amount; payment rows point at the inserted client_payments row.';;
