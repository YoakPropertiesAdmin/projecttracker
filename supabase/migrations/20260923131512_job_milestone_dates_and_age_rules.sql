-- Two milestone dates the office owns, kept separate from start_date (which is
-- when the record landed in TradeDesk, not when anything was signed — the
-- distinction matters, because seeding an ageing rule from start_date would
-- have produced a board where nothing is ever late).
alter table public.jobs
  add column if not exists contract_signed_date   timestamptz,
  add column if not exists materials_ordered_date timestamptz,
  -- When the opportunity was created in GoHighLevel. Captured on every sync so
  -- there is always a defensible date to seed the signed date from.
  add column if not exists ghl_created_at         timestamptz;

create index if not exists jobs_contract_signed_idx
  on public.jobs (contract_signed_date) where contract_signed_date is not null;
create index if not exists jobs_materials_ordered_idx
  on public.jobs (materials_ordered_date) where materials_ordered_date is not null;

-- Ageing rules as data. Thresholds move with the season and the trade; changing
-- one should be an UPDATE, not a redeploy.
create table if not exists public.job_age_rules (
  key                  text primary key,
  label                text not null,
  date_field           text not null
                       check (date_field in ('contract_signed_date','materials_ordered_date')),
  weeks                int  not null check (weeks > 0),
  emoji                text not null default '🚩',
  -- The clock stops once the job reaches this stage. A job that is scheduled is
  -- not stalled, however long it took to get there.
  stops_at_stage       text not null default 'scheduled',
  missing_date_prompt  text,
  active               boolean not null default true,
  sort_order           int not null default 100
);

comment on table public.job_age_rules is
  'Staleness rules for the board. A job trips a rule when its date_field is older than `weeks` AND it has not yet reached stops_at_stage.';

insert into public.job_age_rules (key, label, date_field, weeks, emoji, stops_at_stage, missing_date_prompt, sort_order) values
  ('signed_stale',    'Signed over 10 weeks ago',     'contract_signed_date',   10, '🚩', 'scheduled',
   'No contract signed date — set it so this job is tracked for ageing.', 10),
  ('materials_stale', 'Materials ordered over 16 weeks ago', 'materials_ordered_date', 16, '🟡', 'scheduled',
   'No materials ordered date — set it once materials go on order.', 20)
on conflict (key) do nothing;

alter table public.job_age_rules enable row level security;
drop policy if exists job_age_rules_read on public.job_age_rules;
create policy job_age_rules_read on public.job_age_rules
  for select to authenticated using (true);
drop policy if exists job_age_rules_write on public.job_age_rules;
create policy job_age_rules_write on public.job_age_rules
  for all to authenticated using (true) with check (true);;
