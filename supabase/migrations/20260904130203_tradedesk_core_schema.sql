-- TradeDesk job & payment tracker — core relational schema.
-- Replaces the single localStorage JSON blob with real tables so that
-- concurrent users cannot clobber each other's writes.

create extension if not exists pgcrypto;

-- Job numbers are assigned by the database, not the client, so two people
-- creating a job at the same moment can never collide.
create sequence if not exists job_number_seq start with 1009;

create table if not exists public.vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  category      text        not null default 'Materials',
  phone         text        not null default '',
  email         text        not null default '',
  notes         text        not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid        references auth.users(id) on delete set null,
  constraint vendors_name_unique unique (name)
);

create table if not exists public.jobs (
  id               uuid primary key default gen_random_uuid(),
  number           bigint      not null unique default nextval('job_number_seq'),
  customer_name    text        not null,
  customer_phone   text        not null default '',
  customer_email   text        not null default '',
  customer_address text        not null default '',
  trade            text        not null default 'roofing',
  stage            text        not null default 'signed',
  contract_amount  numeric(12,2) not null default 0 check (contract_amount >= 0),
  start_date       timestamptz,
  target_date      timestamptz,
  notes            text        not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid        references auth.users(id) on delete set null
);

-- Money the client has paid us against the contract.
create table if not exists public.client_payments (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid        not null references public.jobs(id) on delete cascade,
  amount        numeric(12,2) not null check (amount >= 0),
  payment_date  timestamptz not null default now(),
  method        text        not null default 'Check',
  note          text        not null default '',
  created_at    timestamptz not null default now(),
  created_by    uuid        references auth.users(id) on delete set null
);

-- Money we owe / have paid out on a job. vendor_name is stored as a snapshot
-- alongside the FK: a financial record should keep the name it was booked
-- under even if the vendor is later renamed or deleted.
create table if not exists public.vendor_payments (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid        not null references public.jobs(id) on delete cascade,
  vendor_id     uuid        references public.vendors(id) on delete set null,
  vendor_name   text        not null,
  category      text        not null default 'Materials',
  amount        numeric(12,2) not null check (amount >= 0),
  payment_date  timestamptz not null default now(),
  status        text        not null default 'pending' check (status in ('paid','pending')),
  note          text        not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid        references auth.users(id) on delete set null
);

create index if not exists idx_jobs_stage             on public.jobs (stage);
create index if not exists idx_jobs_trade             on public.jobs (trade);
create index if not exists idx_client_payments_job    on public.client_payments (job_id);
create index if not exists idx_vendor_payments_job    on public.vendor_payments (job_id);
create index if not exists idx_vendor_payments_vendor on public.vendor_payments (vendor_id);
create index if not exists idx_vendor_payments_status on public.vendor_payments (status);

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_jobs_updated_at on public.jobs;
create trigger trg_jobs_updated_at before update on public.jobs
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_vendors_updated_at on public.vendors;
create trigger trg_vendors_updated_at before update on public.vendors
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_vendor_payments_updated_at on public.vendor_payments;
create trigger trg_vendor_payments_updated_at before update on public.vendor_payments
  for each row execute function public.touch_updated_at();;
