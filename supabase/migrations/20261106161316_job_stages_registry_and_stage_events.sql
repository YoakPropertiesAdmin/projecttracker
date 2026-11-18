create table public.job_stages (key text primary key, label text not null, sort_order int not null, is_complete boolean not null default false, active boolean not null default true, created_at timestamptz not null default now());
comment on table public.job_stages is 'Registry of board stages. is_complete marks stages that mean the work is done; the first move from a not-complete stage into one is the job''s completion date.';
insert into public.job_stages (key, label, sort_order, is_complete) values ('signed','Contract Signed',10,false),('permitting','Permitting & Measure',20,false),('materials_ordered','Materials Ordered',30,false),('scheduled','Scheduled',40,false),('in_progress','In Progress',50,false),('punch_list','Punch List',60,false),('completed','Completed',70,true),('closed','Closed / Paid',80,true);
alter table public.job_stages enable row level security;
create policy job_stages_read on public.job_stages for select to authenticated using (true);
create policy job_stages_write on public.job_stages for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.job_stages from anon;

create table public.job_stage_events (id bigint generated always as identity primary key, job_id uuid not null references public.jobs(id) on delete cascade, from_stage text, to_stage text not null, changed_at timestamptz not null default now(), changed_by uuid, source text not null);
comment on table public.job_stage_events is 'Append-only log of jobs.stage changes, written by trigger. source = app (a signed-in user) or system (GHL sync, cron). Forward-only: nothing before 2026-11-06.';
create index job_stage_events_job_idx on public.job_stage_events (job_id, changed_at);
create index job_stage_events_to_idx on public.job_stage_events (to_stage, changed_at);
alter table public.job_stage_events enable row level security;
create policy job_stage_events_admin_read on public.job_stage_events for select to authenticated using (public.is_admin());
revoke all on public.job_stage_events from anon;
revoke insert, update, delete, truncate on public.job_stage_events from authenticated;

create or replace function public.log_job_stage_change() returns trigger language plpgsql security definer set search_path to '' as $fn$ begin if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return new; end if; if new.stage is null then return new; end if; insert into public.job_stage_events (job_id, from_stage, to_stage, changed_by, source) values (new.id, case when tg_op = 'UPDATE' then old.stage end, new.stage, auth.uid(), case when auth.uid() is null then 'system' else 'app' end); return new; end $fn$;
revoke execute on function public.log_job_stage_change() from public, anon, authenticated;
create trigger jobs_log_stage_change after insert or update of stage on public.jobs for each row execute function public.log_job_stage_change();

create or replace function public.job_completion_dates() returns table (job_id uuid, completed_at timestamptz) language sql stable security definer set search_path to 'public' as $fn$ select e.job_id, min(e.changed_at) from public.job_stage_events e join public.job_stages t on t.key = e.to_stage and t.is_complete left join public.job_stages f on f.key = e.from_stage where e.from_stage is not null and not coalesce(f.is_complete, false) and public.is_admin() group by e.job_id $fn$;
comment on function public.job_completion_dates() is 'Admin only. First move from a not-complete stage into a complete stage, per job. Jobs created already complete, or completed before stage logging began, have no row.';
revoke execute on function public.job_completion_dates() from public, anon;
grant execute on function public.job_completion_dates() to authenticated;;
