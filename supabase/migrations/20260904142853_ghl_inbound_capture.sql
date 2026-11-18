-- Landing table for raw GoHighLevel webhook deliveries.
--
-- Capture first, map later: GHL's payload shape varies by trigger and by what
-- custom fields the sub-account has, so the field mapping gets written against
-- a real delivery rather than guessed. This table also gives us replay (the
-- payload is kept verbatim) and somewhere failures are visible instead of a
-- job quietly never arriving.
create table if not exists public.ghl_inbound (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  source        text        not null default 'ghl',
  event         text,                       -- filled in once we know where GHL puts it
  headers       jsonb       not null default '{}'::jsonb,
  payload       jsonb       not null,
  processed_at  timestamptz,                -- null = not yet turned into a job
  job_id        uuid        references public.jobs(id) on delete set null,
  error         text
);

create index if not exists idx_ghl_inbound_received on public.ghl_inbound (received_at desc);
create index if not exists idx_ghl_inbound_unprocessed on public.ghl_inbound (received_at desc) where processed_at is null;

alter table public.ghl_inbound enable row level security;
revoke all on public.ghl_inbound from anon;

-- Staff can look at what came in; only the service role (the edge function)
-- writes. No insert/update/delete policy is deliberate.
drop policy if exists ghl_inbound_authenticated_read on public.ghl_inbound;
create policy ghl_inbound_authenticated_read on public.ghl_inbound
  for select to authenticated using (true);

-- The shared secret the webhook endpoint checks. Stored as a SHA-256 hash so
-- the plaintext token exists only in GHL's workflow config. Rotating is one
-- update of this row. No policies at all: service role only.
create table if not exists public.webhook_credentials (
  id          text primary key,
  secret_hash text        not null,
  note        text        not null default '',
  rotated_at  timestamptz not null default now()
);

alter table public.webhook_credentials enable row level security;
revoke all on public.webhook_credentials from anon, authenticated;

insert into public.webhook_credentials (id, secret_hash, note)
values ('ghl', 'f51a7af29f181b3507456e4c7502f02c0e436146dd7fe7604d4a82d0472a65ca',
        'GoHighLevel -> ghl-inbound edge function')
on conflict (id) do update
  set secret_hash = excluded.secret_hash, rotated_at = now();

-- Needed by the mapping step, added now so there is only one migration:
-- the GHL opportunity id is what makes a redelivered webhook update the same
-- job instead of creating a second one.
alter table public.jobs add column if not exists ghl_opportunity_id text;
create unique index if not exists idx_jobs_ghl_opportunity on public.jobs (ghl_opportunity_id)
  where ghl_opportunity_id is not null;;
