-- GHL Marketplace app: installs (tokens in Vault), signed-webhook dedupe, sync audit, SSO user links.
-- Additive only. Nothing existing is altered.

create table public.ghl_installations (
  location_id          text primary key,
  company_id           text,
  user_type            text,
  access_secret_id     uuid,          -- vault.secrets id
  refresh_secret_id    uuid,          -- vault.secrets id
  expires_at           timestamptz,
  scopes               text,
  refresh_lock_until   timestamptz,   -- lease so two refreshes never race (GHL rotates refresh tokens)
  last_refreshed_at    timestamptz,
  installed_at         timestamptz not null default now(),
  uninstalled_at       timestamptz,
  updated_at           timestamptz not null default now()
);
comment on table public.ghl_installations is 'One row per GHL location that installed the TradeDesk marketplace app. Tokens live in Vault; this row only holds their secret ids. Service role only.';
alter table public.ghl_installations enable row level security;

create table public.ghl_webhook_events (
  webhook_id    text primary key,
  type          text not null,
  location_id   text,
  payload       jsonb not null,
  signature_ok  boolean not null,
  inbound_id    uuid references public.ghl_inbound(id) on delete set null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
comment on table public.ghl_webhook_events is 'Signed marketplace-app webhook deliveries. PK on webhookId makes a GHL retry a no-op.';
create index ghl_webhook_events_type_idx on public.ghl_webhook_events (type, received_at desc);
alter table public.ghl_webhook_events enable row level security;

create table public.ghl_sync_log (
  id          bigserial primary key,
  direction   text not null check (direction in ('in','out')),
  entity      text not null check (entity in ('contact','opportunity','install','sso')),
  job_id      uuid references public.jobs(id) on delete set null,
  ghl_id      text,
  action      text not null,
  ok          boolean not null,
  source      text,               -- marketplace_webhook | workflow_webhook | sweep | outbound | sso
  detail      jsonb,
  created_at  timestamptz not null default now()
);
comment on table public.ghl_sync_log is 'Audit of every GHL read/write the marketplace app performs. Used for the parallel run and echo-loop checks.';
create index ghl_sync_log_ghl_id_idx on public.ghl_sync_log (ghl_id, created_at desc);
alter table public.ghl_sync_log enable row level security;

create table public.ghl_user_links (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  ghl_user_id  text not null unique,
  ghl_email    text,
  linked_at    timestamptz not null default now(),
  last_sso_at  timestamptz
);
comment on table public.ghl_user_links is 'TradeDesk login <-> GHL user. Created on first SSO by email match; unknown GHL users are denied, never auto-created.';
alter table public.ghl_user_links enable row level security;

-- ---------------------------------------------------------------- token RPCs (service role only)

create or replace function public.ghl_save_tokens(
  p_location_id text, p_company_id text, p_user_type text,
  p_access_token text, p_refresh_token text, p_expires_in integer, p_scopes text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare r public.ghl_installations%rowtype; v_a uuid; v_r uuid;
begin
  select * into r from public.ghl_installations where location_id = p_location_id for update;

  if found and r.access_secret_id is not null then
    perform vault.update_secret(r.access_secret_id, p_access_token);
    v_a := r.access_secret_id;
  else
    v_a := vault.create_secret(p_access_token, 'ghl_access_' || p_location_id, 'GHL app access token');
  end if;

  if found and r.refresh_secret_id is not null then
    perform vault.update_secret(r.refresh_secret_id, p_refresh_token);
    v_r := r.refresh_secret_id;
  else
    v_r := vault.create_secret(p_refresh_token, 'ghl_refresh_' || p_location_id, 'GHL app refresh token');
  end if;

  insert into public.ghl_installations as i
    (location_id, company_id, user_type, access_secret_id, refresh_secret_id, expires_at, scopes,
     last_refreshed_at, uninstalled_at, refresh_lock_until, updated_at)
  values (p_location_id, p_company_id, p_user_type, v_a, v_r,
          now() + make_interval(secs => p_expires_in), p_scopes, now(), null, null, now())
  on conflict (location_id) do update set
    company_id = coalesce(excluded.company_id, i.company_id),
    user_type = coalesce(excluded.user_type, i.user_type),
    access_secret_id = excluded.access_secret_id,
    refresh_secret_id = excluded.refresh_secret_id,
    expires_at = excluded.expires_at,
    scopes = coalesce(excluded.scopes, i.scopes),
    last_refreshed_at = now(),
    uninstalled_at = null,
    refresh_lock_until = null,
    updated_at = now();
end $$;

create or replace function public.ghl_get_tokens(p_location_id text)
returns table (access_token text, refresh_token text, expires_at timestamptz, company_id text, uninstalled_at timestamptz)
language sql security definer set search_path = ''
as $$
  select a.decrypted_secret, rf.decrypted_secret, i.expires_at, i.company_id, i.uninstalled_at
    from public.ghl_installations i
    left join vault.decrypted_secrets a  on a.id  = i.access_secret_id
    left join vault.decrypted_secrets rf on rf.id = i.refresh_secret_id
   where i.location_id = p_location_id;
$$;

-- Atomic lease: true means this caller may refresh now; false means another refresh is in flight.
create or replace function public.ghl_claim_refresh(p_location_id text, p_lease_seconds integer default 30)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.ghl_installations
     set refresh_lock_until = now() + make_interval(secs => p_lease_seconds)
   where location_id = p_location_id
     and (refresh_lock_until is null or refresh_lock_until < now());
  return found;
end $$;

create or replace function public.ghl_mark_uninstalled(p_location_id text)
returns void
language sql security definer set search_path = ''
as $$
  update public.ghl_installations set uninstalled_at = now(), updated_at = now()
   where location_id = p_location_id;
$$;

revoke all on function public.ghl_save_tokens(text,text,text,text,text,integer,text) from public, anon, authenticated;
revoke all on function public.ghl_get_tokens(text)            from public, anon, authenticated;
revoke all on function public.ghl_claim_refresh(text,integer) from public, anon, authenticated;
revoke all on function public.ghl_mark_uninstalled(text)      from public, anon, authenticated;
grant execute on function public.ghl_save_tokens(text,text,text,text,text,integer,text) to service_role;
grant execute on function public.ghl_get_tokens(text)            to service_role;
grant execute on function public.ghl_claim_refresh(text,integer) to service_role;
grant execute on function public.ghl_mark_uninstalled(text)      to service_role;

revoke all on public.ghl_installations, public.ghl_webhook_events, public.ghl_sync_log, public.ghl_user_links from anon, authenticated;
;
