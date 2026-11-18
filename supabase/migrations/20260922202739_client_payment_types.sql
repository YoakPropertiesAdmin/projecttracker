-- Reporting on "initial deposits" needs the ledger to say which payment is an
-- initial deposit. Until now nothing did: every row is a manual entry with a
-- method (Check, Financing, Cash) and no notion of where it sits in the
-- sequence, and the Initial/Second/Final labels only ever existed on rows that
-- came from GoHighLevel — of which there are none.

create table if not exists public.payment_types (
  key         text primary key,
  label       text not null,
  sort_order  int  not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.payment_types is
  'Client payment classifications. A registry so the office can add one without a redeploy.';

insert into public.payment_types (key, label, sort_order) values
  ('initial_deposit', 'Initial deposit', 10),
  ('second_deposit',  'Second deposit',  20),
  ('progress',        'Progress payment',30),
  ('final_payment',   'Final payment',   40),
  ('other',           'Other',           90)
on conflict (key) do nothing;

alter table public.payment_types enable row level security;
drop policy if exists payment_types_read on public.payment_types;
create policy payment_types_read on public.payment_types
  for select to authenticated using (true);
drop policy if exists payment_types_write on public.payment_types;
create policy payment_types_write on public.payment_types
  for all to authenticated using (true) with check (true);

alter table public.client_payments
  add column if not exists payment_type text references public.payment_types(key);

create index if not exists client_payments_type_idx
  on public.client_payments (payment_type);
-- Reports are almost always a date window; this is the index that serves them.
create index if not exists client_payments_date_idx
  on public.client_payments (payment_date);
create index if not exists vendor_payments_date_idx
  on public.vendor_payments (payment_date);

-- Backfill by sequence: the earliest payment on a job is its initial deposit,
-- the next its second, anything after that a progress payment, EXCEPT where a
-- payment settles the contract in full — that reads as the final payment.
with ranked as (
  select p.id,
         row_number() over (partition by p.job_id order by p.payment_date, p.created_at) as seq,
         sum(p.amount) over (partition by p.job_id order by p.payment_date, p.created_at
                             rows between unbounded preceding and current row) as running,
         j.contract_amount
    from public.client_payments p
    join public.jobs j on j.id = p.job_id
)
update public.client_payments cp
   set payment_type = case
         when r.contract_amount > 0 and r.running >= r.contract_amount - 0.01 then 'final_payment'
         when r.seq = 1 then 'initial_deposit'
         when r.seq = 2 then 'second_deposit'
         else 'progress'
       end
  from ranked r
 where r.id = cp.id
   and cp.payment_type is null;;
