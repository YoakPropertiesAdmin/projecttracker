-- Vendor payment documents (2026-11-24): invoices, receipts, credit memos
-- attached to a vendor bill on the job card. Optional; any number per bill.
-- Files live in the private Storage bucket "vendor-docs" under
-- <job_id>/<vendor_payment_id>/<document id>-<file name>; this table is the
-- link and what the app lists. Admin-only, like vendor_payments.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-docs', 'vendor-docs', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.vendor_payment_documents (
  id uuid primary key default gen_random_uuid(),
  vendor_payment_id uuid not null references public.vendor_payments(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text not null default '',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null
);
comment on table public.vendor_payment_documents is 'Files (invoice, receipt, credit memo) attached to a vendor bill. The file is in Storage bucket vendor-docs at storage_path. Removing a row here does not delete the file, so Undo can relink it.';
create index if not exists vendor_payment_documents_payment_idx on public.vendor_payment_documents(vendor_payment_id);
create index if not exists vendor_payment_documents_job_idx on public.vendor_payment_documents(job_id);

alter table public.vendor_payment_documents enable row level security;
create policy vpd_admin_read on public.vendor_payment_documents for select to authenticated using (public.is_admin());
create policy vpd_admin_insert on public.vendor_payment_documents for insert to authenticated with check (public.is_admin());
create policy vpd_admin_update on public.vendor_payment_documents for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy vpd_admin_delete on public.vendor_payment_documents for delete to authenticated using (public.is_admin());
revoke all on public.vendor_payment_documents from anon;
grant select, insert, update, delete on public.vendor_payment_documents to authenticated;

-- Storage: only admins can read (signed links), upload or remove files in
-- this bucket. Nobody else, and never anonymous.
create policy vendor_docs_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'vendor-docs' and public.is_admin());
create policy vendor_docs_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'vendor-docs' and public.is_admin());
create policy vendor_docs_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'vendor-docs' and public.is_admin());
