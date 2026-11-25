-- Job notes follow-up (2026-11-25, Joshua's calls after the dry run):
--  1. The migration skips old notes that are only the customer's name or
--     address (copied from the opportunity Notes field): action 'skip',
--     status 'done' at planning time, so migrate_apply never pushes them.
--  2. Job cards hide GHL notes written before the customer was in a monitored
--     pipeline (before their first Production opportunity): lead-stage AI
--     transcripts, intake forms, early sales notes. The mirror keeps them.
--     A GHL note that an old TradeDesk note matched stays visible.
--  3. jobs.notes is frozen for app users; job notes live in GHL now.

create or replace function public.note_key(s text) returns text language sql immutable as $fn$
  select btrim(regexp_replace(regexp_replace(public.note_norm(s), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$fn$;

alter table public.note_migration drop constraint if exists note_migration_action_check;
alter table public.note_migration add constraint note_migration_action_check
  check (action in ('push', 'already_in_ghl', 'local', 'skip'));

create or replace function public.note_migration_plan()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare r record; v_hit text; v_want text; v_key text; v_name text; v_addr text; v_action text;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'office only' using errcode = '42501'; end if;
  delete from public.note_migration where status <> 'done' or action = 'skip';
  for r in select j.id, j.number, j.ghl_contact_id, j.notes, j.customer_name, j.customer_address from public.jobs j
            where btrim(coalesce(j.notes, '')) <> ''
              and not exists (select 1 from public.note_migration m where m.job_id = j.id) loop
    v_hit := null;
    v_want := public.note_norm(r.notes);
    v_key := public.note_key(r.notes);
    v_name := public.note_key(r.customer_name);
    v_addr := public.note_key(r.customer_address);
    if v_key = '' or v_key = v_name or v_key = v_addr
       or (v_name <> '' and v_name like v_key || '%')
       or (length(v_key) > 8 and v_addr <> '' and v_addr like v_key || '%')
       or (length(v_key) > 8 and v_addr <> '' and v_key like v_addr || '%' and length(v_key) < length(v_addr) + 12)
       or (v_name <> '' and v_key like v_name || ' %' and length(v_key) < length(v_name) + 15) then
      v_action := 'skip';
    elsif public.ghl_contact_monitored(r.ghl_contact_id) then
      select n.ghl_note_id into v_hit from public.contact_notes n
       where n.contact_id = r.ghl_contact_id and n.ghl_note_id is not null and n.deleted_at is null
         and (public.note_norm(n.body) = v_want or strpos(public.note_norm(n.body), v_want) > 0
              or (length(public.note_norm(n.body)) > 20 and strpos(v_want, public.note_norm(n.body)) > 0))
       order by n.date_added limit 1;
      v_action := case when v_hit is null then 'push' else 'already_in_ghl' end;
    else
      v_action := 'local';
    end if;
    insert into public.note_migration (job_id, job_number, contact_id, legacy_body, action, matched_note_id, status)
    values (r.id, r.number, case when v_action in ('local', 'skip') then null else r.ghl_contact_id end, r.notes,
            v_action, v_hit, case when v_action = 'skip' then 'done' else 'planned' end);
  end loop;
  return (select jsonb_object_agg(action || ':' || status, n) from
           (select action, status, count(*) n from public.note_migration group by 1, 2) x);
end $fn$;
revoke execute on function public.note_migration_plan() from public, anon, authenticated;

/** When a contact entered a monitored pipeline: its first Production opportunity. */
create or replace function public.ghl_contact_monitored_since(p_contact text)
returns timestamptz language sql stable security definer set search_path to 'public' as $fn$
  select min(coalesce(j.ghl_created_at, j.created_at)) from public.jobs j
   where j.ghl_contact_id = p_contact and j.ghl_opportunity_id is not null
$fn$;
revoke execute on function public.ghl_contact_monitored_since(text) from public, anon, authenticated;

create or replace function public.job_notes(p_job uuid)
returns table (id uuid, ghl_note_id text, body text, author text, date_added timestamptz,
               source text, job_id uuid, job_number bigint, in_ghl boolean)
language sql stable security definer set search_path to 'public' as $fn$
  with j as (select id, ghl_contact_id, public.ghl_contact_monitored_since(ghl_contact_id) since
               from public.jobs where id = p_job
               and (auth.uid() is null or public.can_see_job(p_job)))
  select n.id, n.ghl_note_id, n.body,
         coalesce(n.author_name, gu.name, case when n.ghl_user_id is null then 'GHL automation' else 'GHL user' end),
         n.date_added, n.source, n.job_id, oj.number, n.ghl_note_id is not null
    from public.contact_notes n
    join j on (n.contact_id = j.ghl_contact_id and j.since is not null) or n.job_id = j.id
    left join public.ghl_users gu on gu.ghl_user_id = n.ghl_user_id
    left join public.jobs oj on oj.id = n.job_id
   where n.deleted_at is null
     and (n.source <> 'ghl' or n.date_added >= j.since
          or exists (select 1 from public.note_migration m
                      where m.matched_note_id = n.ghl_note_id and m.contact_id = n.contact_id))
   order by (n.source = 'migration'), n.date_added desc
$fn$;
revoke execute on function public.job_notes(uuid) from public, anon;
grant execute on function public.job_notes(uuid) to authenticated;

create or replace function public.jobs_notes_frozen() returns trigger
language plpgsql set search_path to 'public' as $fn$
begin
  if auth.uid() is not null and new.notes is distinct from old.notes then
    raise exception 'Job notes live in GHL now. Use Add note on the job card.' using errcode = '42501';
  end if;
  return new;
end $fn$;
drop trigger if exists jobs_notes_frozen on public.jobs;
create trigger jobs_notes_frozen before update of notes on public.jobs
  for each row execute function public.jobs_notes_frozen();
