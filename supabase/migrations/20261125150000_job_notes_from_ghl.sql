-- Job notes, fresh start (2026-11-25). GHL owns notes: they live on the GHL
-- contact's Notes tab. TradeDesk keeps a mirror (contact_notes), filled by the
-- marketplace-app Note* webhooks and by td-notes when a job card is opened,
-- and shows it as a dated log. "Add note" in TradeDesk writes to GHL first.
--
-- Only contacts on a monitored-pipeline job are mirrored: a contact whose
-- TradeDesk job has a GHL opportunity (jobs only come from the Production
-- pipeline). Notes on every other GHL contact are never stored.
--
-- Jobs with no GHL contact (manual / Yoak internal) keep TradeDesk-only notes
-- here with contact_id null and job_id set.

create table public.contact_notes (
  id            uuid primary key default gen_random_uuid(),
  ghl_note_id   text unique,
  contact_id    text,
  job_id        uuid references public.jobs(id) on delete cascade,
  body          text not null default '',
  ghl_user_id   text,
  author_name   text,
  created_by    uuid,
  date_added    timestamptz not null default now(),
  source        text not null default 'ghl'
                check (source in ('ghl', 'tradedesk', 'migration', 'local')),
  deleted_at    timestamptz,
  received_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint contact_notes_has_owner check (contact_id is not null or job_id is not null),
  constraint contact_notes_ghl_has_contact check (ghl_note_id is null or contact_id is not null)
);
comment on table public.contact_notes is
  'Mirror of GHL contact notes for contacts on monitored-pipeline TradeDesk jobs, plus TradeDesk-only notes for jobs with no GHL contact (contact_id null). source: ghl = written in GHL; tradedesk = added from a TradeDesk job card (stored in GHL); migration = a job''s old TradeDesk notes moved over on 2026-11-25; local = TradeDesk-only. Written only by service role (td-notes, td-app-webhook).';
create index contact_notes_contact_idx on public.contact_notes (contact_id) where contact_id is not null;
create index contact_notes_job_idx on public.contact_notes (job_id) where job_id is not null;

alter table public.contact_notes enable row level security;
create policy contact_notes_read on public.contact_notes for select to authenticated using (
  deleted_at is null and (
    (job_id is not null and public.can_see_job(job_id))
    or exists (select 1 from public.jobs j where j.ghl_contact_id = contact_notes.contact_id and public.can_see_job(j.id))
  ));
revoke insert, update, delete on public.contact_notes from anon, authenticated;

/** True when a GHL contact belongs to a TradeDesk job from a monitored pipeline. */
create or replace function public.ghl_contact_monitored(p_contact text)
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select p_contact is not null and exists (
    select 1 from public.jobs j where j.ghl_contact_id = p_contact and j.ghl_opportunity_id is not null)
$fn$;
revoke execute on function public.ghl_contact_monitored(text) from public, anon, authenticated;

/**
 * Upsert GHL notes into the mirror. p_notes: [{id, contactId, body, userId, dateAdded}].
 * Notes for contacts that are not monitored are skipped. A note TradeDesk wrote keeps
 * its source / job / author when GHL echoes it back. p_full_contact: the list is the
 * contact's complete set, so mirrored notes missing from it are marked deleted.
 */
create or replace function public.contact_notes_upsert(
  p_notes jsonb, p_source text default 'ghl', p_job uuid default null,
  p_created_by uuid default null, p_author text default null, p_full_contact text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare n jsonb; v_up int := 0; v_skip int := 0; v_del int := 0; v_ids text[] := '{}';
begin
  for n in select * from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) loop
    if not public.ghl_contact_monitored(n ->> 'contactId') then v_skip := v_skip + 1; continue; end if;
    v_ids := v_ids || (n ->> 'id');
    insert into public.contact_notes as c (ghl_note_id, contact_id, job_id, body, ghl_user_id, author_name,
                                           created_by, date_added, source)
    values (n ->> 'id', n ->> 'contactId', p_job, coalesce(n ->> 'body', ''), nullif(n ->> 'userId', ''),
            p_author, p_created_by, coalesce((n ->> 'dateAdded')::timestamptz, now()), coalesce(p_source, 'ghl'))
    on conflict (ghl_note_id) do update set
      body = excluded.body,
      contact_id = excluded.contact_id,
      ghl_user_id = coalesce(excluded.ghl_user_id, c.ghl_user_id),
      date_added = excluded.date_added,
      deleted_at = null,
      updated_at = now(),
      source = case when p_source = 'ghl' then c.source else excluded.source end,
      job_id = coalesce(c.job_id, excluded.job_id),
      created_by = coalesce(c.created_by, excluded.created_by),
      author_name = coalesce(c.author_name, excluded.author_name);
    v_up := v_up + 1;
  end loop;
  if p_full_contact is not null then
    update public.contact_notes set deleted_at = now(), updated_at = now()
     where contact_id = p_full_contact and ghl_note_id is not null and deleted_at is null
       and not (ghl_note_id = any (v_ids));
    get diagnostics v_del = row_count;
  end if;
  return jsonb_build_object('upserted', v_up, 'skipped_unmonitored', v_skip, 'marked_deleted', v_del);
end $fn$;
revoke execute on function public.contact_notes_upsert(jsonb, text, uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.contact_notes_mark_deleted(p_note text)
returns int language sql security definer set search_path to 'public' as $fn$
  with u as (update public.contact_notes set deleted_at = now(), updated_at = now()
              where ghl_note_id = p_note and deleted_at is null returning 1)
  select count(*)::int from u
$fn$;
revoke execute on function public.contact_notes_mark_deleted(text) from public, anon, authenticated;

/**
 * The note log for one job card, newest first, with a display author.
 * Notes moved over from the old TradeDesk notes box are sorted last (they are
 * the job's first entry), whatever date GHL stamped on them.
 */
create or replace function public.job_notes(p_job uuid)
returns table (id uuid, ghl_note_id text, body text, author text, date_added timestamptz,
               source text, job_id uuid, job_number bigint, in_ghl boolean)
language sql stable security definer set search_path to 'public' as $fn$
  with j as (select id, ghl_contact_id from public.jobs where id = p_job
               and (auth.uid() is null or public.can_see_job(p_job)))
  select n.id, n.ghl_note_id, n.body,
         coalesce(n.author_name, gu.name, case when n.ghl_user_id is null then 'GHL automation' else 'GHL user' end),
         n.date_added, n.source, n.job_id, oj.number, n.ghl_note_id is not null
    from public.contact_notes n
    join j on (n.contact_id = j.ghl_contact_id and public.ghl_contact_monitored(j.ghl_contact_id)) or n.job_id = j.id
    left join public.ghl_users gu on gu.ghl_user_id = n.ghl_user_id
    left join public.jobs oj on oj.id = n.job_id
   where n.deleted_at is null
   order by (n.source = 'migration'), n.date_added desc
$fn$;
revoke execute on function public.job_notes(uuid) from public, anon;
grant execute on function public.job_notes(uuid) to authenticated;

-- Migration of the old jobs.notes box: one row per job with text in it.
-- action: push (to the GHL contact) | already_in_ghl | local (no monitored contact) | empty
-- status: planned | done | failed
create table public.note_migration (
  job_id          uuid primary key references public.jobs(id) on delete cascade,
  job_number      bigint,
  contact_id      text,
  legacy_body     text not null,
  action          text not null check (action in ('push', 'already_in_ghl', 'local')),
  status          text not null default 'planned' check (status in ('planned', 'done', 'failed')),
  matched_note_id text,
  contact_note_id uuid references public.contact_notes(id) on delete set null,
  error           text,
  planned_at      timestamptz not null default now(),
  applied_at      timestamptz
);
alter table public.note_migration enable row level security;
create policy note_migration_admin_read on public.note_migration for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.note_migration from anon, authenticated;

create or replace function public.note_norm(s text) returns text language sql immutable as $fn$
  select lower(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(s, ''), '<[^>]+>', ' ', 'g'), '&nbsp;', ' ', 'g'), '\s+', ' ', 'g')))
$fn$;

/** (Re)plan the migration from the mirror. Rows already done are left alone. Run after the seed. */
create or replace function public.note_migration_plan()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare r record; v_hit text; v_want text; v_action text;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'office only' using errcode = '42501'; end if;
  delete from public.note_migration where status <> 'done';
  for r in select j.id, j.number, j.ghl_contact_id, j.notes from public.jobs j
            where btrim(coalesce(j.notes, '')) <> ''
              and not exists (select 1 from public.note_migration m where m.job_id = j.id) loop
    v_hit := null;
    v_want := public.note_norm(r.notes);
    if public.ghl_contact_monitored(r.ghl_contact_id) then
      select n.ghl_note_id into v_hit from public.contact_notes n
       where n.contact_id = r.ghl_contact_id and n.ghl_note_id is not null and n.deleted_at is null
         and (public.note_norm(n.body) = v_want or strpos(public.note_norm(n.body), v_want) > 0
              or (length(public.note_norm(n.body)) > 20 and strpos(v_want, public.note_norm(n.body)) > 0))
       order by n.date_added limit 1;
      v_action := case when v_hit is null then 'push' else 'already_in_ghl' end;
    else
      v_action := 'local';
    end if;
    insert into public.note_migration (job_id, job_number, contact_id, legacy_body, action, matched_note_id)
    values (r.id, r.number, case when v_action = 'local' then null else r.ghl_contact_id end, r.notes, v_action, v_hit);
  end loop;
  return (select jsonb_object_agg(action || ':' || status, n) from
           (select action, status, count(*) n from public.note_migration group by 1, 2) x);
end $fn$;
revoke execute on function public.note_migration_plan() from public, anon, authenticated;

-- New jobs no longer copy the opportunity's Notes custom field into jobs.notes.
do $do$
declare d text := pg_get_functiondef('public.ghl_sync_opportunities_core'::regproc);
begin
  if position('coalesce(r ->> ''notes'', '''')' in d) = 0 then raise exception 'notes copy not found'; end if;
  execute replace(d, 'coalesce(r ->> ''notes'', '''')', '''''');
end $do$;
