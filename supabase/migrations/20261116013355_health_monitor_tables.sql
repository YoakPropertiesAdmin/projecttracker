create table if not exists public.health_checks (
  check_key text primary key,
  label text not null,
  severity text not null default 'warn' check (severity in ('info','warn','error')),
  enabled boolean not null default true,
  query text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.health_checks is 'Layer-1 health monitor registry. Each query returns zero rows when healthy; each row returned (columns ref, title, detail jsonb, optional severity) is one finding. Read-only queries only.';

create table if not exists public.health_findings (
  id bigint generated always as identity primary key,
  check_key text not null references public.health_checks(check_key) on delete cascade,
  ref text not null default '',
  severity text not null,
  title text not null,
  detail jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  occurrences integer not null default 1,
  resolved_at timestamptz,
  notified_at timestamptz,
  resolved_notified_at timestamptz,
  diagnosis text,
  resolution text
);
create unique index if not exists health_findings_open_uq on public.health_findings (check_key, ref) where resolved_at is null;
create index if not exists health_findings_recent on public.health_findings (first_seen desc);

create table if not exists public.health_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  duration_ms integer,
  checks_run integer,
  opened integer,
  resolved integer,
  open_total integer,
  errors jsonb
);

create table if not exists public.health_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.health_settings (key, value) values
  ('alert_to', '["itadmin@yoakproperties.com"]'::jsonb),
  ('alert_min_severity', '"warn"'::jsonb)
on conflict (key) do nothing;

alter table public.health_checks enable row level security;
alter table public.health_findings enable row level security;
alter table public.health_runs enable row level security;
alter table public.health_settings enable row level security;

create policy health_checks_admin_read on public.health_checks for select to authenticated using (public.is_admin());
create policy health_findings_admin_read on public.health_findings for select to authenticated using (public.is_admin());
create policy health_runs_admin_read on public.health_runs for select to authenticated using (public.is_admin());
create policy health_settings_admin_read on public.health_settings for select to authenticated using (public.is_admin());;
