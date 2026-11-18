-- The native opportunity id becomes the match key. It is immutable and
-- guaranteed unique, which the Project Display ID is not — two open jobs
-- already share 222977, and under the old key they collapse into one.
alter table public.jobs add column if not exists ghl_opportunity_id text;
create unique index if not exists idx_jobs_ghl_opportunity_id
  on public.jobs (ghl_opportunity_id) where ghl_opportunity_id is not null;

-- Display ID drops to a label: still shown, still searchable, no longer unique.
-- Keeping that unique index would make the backfill fail on exactly the
-- duplicates it exists to separate.
drop index if exists idx_jobs_ghl_display_id;
create index if not exists idx_jobs_ghl_display_id on public.jobs (ghl_project_display_id)
  where ghl_project_display_id is not null;

alter table public.ghl_stage_map add column if not exists exclude boolean not null default false;

-- Flag first: ghl_stage_map.flag references it.
-- Chelsea is a person's work queue rather than a step, so it rides as a marker
-- the way On hold does instead of pretending to be a board column.
insert into public.job_flags (key, label, icon, color, tint, sort_order, demote) values
  ('chelsea', 'Chelsea', 'clipboardlist', '#6B5B95', null, 40, false)
on conflict (key) do update set label = excluded.label, icon = excluded.icon, color = excluded.color;

-- Building Department holds municipalities (Brookpark, Westlake, Mentor,
-- Portage County…) at $0 with no display id — permit chasing, not jobs.
insert into public.ghl_stage_map (ghl_stage_name, td_stage, flag, exclude) values
  ('building department', 'signed', null, true),
  ('chelsea',             'signed', 'chelsea', false)
on conflict (ghl_stage_name) do update
  set td_stage = excluded.td_stage, flag = excluded.flag, exclude = excluded.exclude;

-- Every sync run is recorded, so a run that quietly did less than it should is
-- visible rather than inferred. The probe lost 25 of 124 detail fetches without
-- complaint; a backfill that does that and reports success is the failure to
-- design against.
create table if not exists public.ghl_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  mode           text not null,
  enumerated     integer,
  fetched        integer,
  fetch_failures integer,
  created        integer default 0,
  updated        integer default 0,
  skipped        integer default 0,
  status_changes jsonb,
  notes          text[],
  ok             boolean
);

alter table public.ghl_sync_runs enable row level security;
revoke all on public.ghl_sync_runs from anon;
drop policy if exists ghl_sync_runs_read on public.ghl_sync_runs;
create policy ghl_sync_runs_read on public.ghl_sync_runs for select to authenticated using (true);;
