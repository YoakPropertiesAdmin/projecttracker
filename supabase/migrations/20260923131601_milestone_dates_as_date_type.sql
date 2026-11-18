-- These are calendar dates, not instants. Stored as timestamptz, "2026-09-07"
-- becomes 2026-09-07T00:00:00Z and renders as the 6th in Eastern — the exact
-- off-by-one that blanked the reports page. `date` has no timezone to shift.
alter table public.jobs
  alter column contract_signed_date   type date using contract_signed_date::date,
  alter column materials_ordered_date type date using materials_ordered_date::date;

-- Inbound GHL date fields, registered rather than hard-coded, so adding one is
-- a row. Mirrors how ghl_payment_fields works.
create table if not exists public.ghl_date_fields (
  payload_key text primary key,
  job_column  text not null check (job_column in ('contract_signed_date','materials_ordered_date')),
  label       text not null,
  active      boolean not null default true,
  sort_order  int not null default 100
);

insert into public.ghl_date_fields (payload_key, job_column, label, sort_order) values
  ('opportunity contract signed date',   'contract_signed_date',   'Contract signed',   10),
  ('opportunity materials ordered date', 'materials_ordered_date', 'Materials ordered', 20)
on conflict (payload_key) do nothing;

alter table public.ghl_date_fields enable row level security;
drop policy if exists ghl_date_fields_read on public.ghl_date_fields;
create policy ghl_date_fields_read on public.ghl_date_fields
  for select to authenticated using (true);

-- Tolerant parser: accepts a bare date or a full ISO timestamp, and returns
-- null for anything it cannot read rather than guessing. A misread date here
-- turns a card red, so a wrong answer is worse than no answer.
create or replace function public.ghl_date(p jsonb, k text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare v text;
begin
  v := public.ghl_text(p, k);
  if v is null then return null; end if;
  -- YYYY-MM-DD, optionally followed by a time we discard.
  if v ~ '^\d{4}-\d{2}-\d{2}' then
    begin return substring(v from 1 for 10)::date; exception when others then return null; end;
  end if;
  return null;
end;
$$;;
