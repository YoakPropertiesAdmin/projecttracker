-- Every sweep discards opportunities whose GHL stage is marked exclude
-- (today: Building Department, which holds municipalities, not jobs).
-- Discarding them silently means nobody can audit the exclusion, so each
-- sweep now leaves the list behind.

create table if not exists public.ghl_ignored_opportunities (
  opportunity_id   text primary key,
  display_id       text,
  name             text,
  stage_name       text,
  ghl_status       text,
  monetary_value   numeric,
  address          text,
  phone            text,
  email            text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  reviewed         boolean not null default false,
  review_note      text
);

comment on table public.ghl_ignored_opportunities is
  'Open GHL opportunities the sweep skipped because their stage is excluded in ghl_stage_map. Refreshed every sweep; reviewed/review_note are for manual triage and are never overwritten.';

alter table public.ghl_ignored_opportunities enable row level security;

drop policy if exists ghl_ignored_read on public.ghl_ignored_opportunities;
create policy ghl_ignored_read on public.ghl_ignored_opportunities
  for select to authenticated using (true);

drop policy if exists ghl_ignored_triage on public.ghl_ignored_opportunities;
create policy ghl_ignored_triage on public.ghl_ignored_opportunities
  for update to authenticated using (true) with check (true);

create index if not exists ghl_ignored_last_seen_idx
  on public.ghl_ignored_opportunities (last_seen_at desc);;
