create table if not exists public.sales_log_rows (id bigint generated always as identity primary key, source text not null, tab text not null, sheet_row int, customer text, ghl_project_id text, sales_date date, raw_date text, product text, total numeric, job_id uuid references public.jobs(id) on delete set null, match_method text, received_at timestamptz not null default now());
alter table public.sales_log_rows enable row level security;
create policy sales_log_rows_admin_read on public.sales_log_rows for select using (public.is_admin());
create index if not exists sales_log_rows_pid on public.sales_log_rows(ghl_project_id);
comment on table public.sales_log_rows is 'Landing table for the Sales and 2025 Sales Log tabs of 2026-Sales-Log-Live. Source of contract signed (sales) date and product per GHL project #.';;
