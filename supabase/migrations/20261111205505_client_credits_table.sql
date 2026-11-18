create table if not exists public.client_credits (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  amount numeric not null check (amount > 0),
  credit_date timestamptz not null default now(),
  reason text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);
comment on table public.client_credits is 'Money taken off what the client owes after signing. Contract amount is unchanged; a credit lowers the balance due and counts against margin like a cost. Never cash collected.';
create index if not exists client_credits_job_id_idx on public.client_credits(job_id);
alter table public.client_credits enable row level security;
create policy client_credits_admin_read on public.client_credits for select to authenticated using (public.is_admin());
create policy client_credits_admin_insert on public.client_credits for insert to authenticated with check (public.is_admin());
create policy client_credits_admin_update on public.client_credits for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy client_credits_admin_delete on public.client_credits for delete to authenticated using (public.is_admin());
revoke all on public.client_credits from anon;
grant select, insert, update, delete on public.client_credits to authenticated;
delete from public.payment_types where key = 'customer_credit' and not exists (select 1 from public.client_payments where payment_type = 'customer_credit');;
