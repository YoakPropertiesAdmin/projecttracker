alter table public.reconciliation_changes drop constraint if exists reconciliation_changes_kind_check;
alter table public.reconciliation_changes add constraint reconciliation_changes_kind_check check (kind in ('contract','payment','signed_date','trade','ghl_project_type','job_created','status','flag','link'));;
