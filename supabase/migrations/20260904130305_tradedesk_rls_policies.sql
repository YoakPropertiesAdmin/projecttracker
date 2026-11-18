-- Row Level Security: this is internal company financial data on a public URL.
-- Every table denies by default; only signed-in (invited) users get through.
-- The data is shared company-wide, so any authenticated user sees all rows —
-- but an anonymous visitor with the publishable key sees nothing at all.

alter table public.jobs            enable row level security;
alter table public.vendors         enable row level security;
alter table public.client_payments enable row level security;
alter table public.vendor_payments enable row level security;

revoke all on public.jobs, public.vendors, public.client_payments, public.vendor_payments from anon;

do $$
declare t text;
begin
  foreach t in array array['jobs','vendors','client_payments','vendor_payments'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_delete', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_authenticated_read', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (true)',
      t || '_authenticated_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (true) with check (true)',
      t || '_authenticated_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (true)',
      t || '_authenticated_delete', t);
  end loop;
end $$;;
