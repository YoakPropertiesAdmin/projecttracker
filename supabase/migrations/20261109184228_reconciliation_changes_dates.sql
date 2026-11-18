alter table public.reconciliation_changes add column if not exists old_date date, add column if not exists new_date date;
alter table public.reconciliation_changes drop constraint if exists reconciliation_changes_kind_check;
alter table public.reconciliation_changes add constraint reconciliation_changes_kind_check check (kind in ('contract','payment','signed_date'));;
