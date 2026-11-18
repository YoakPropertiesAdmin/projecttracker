create or replace function public.is_job_pm(p_job uuid) returns boolean language sql stable security definer set search_path to 'public' as $f$ select exists (select 1 from public.job_assignments ja join public.assignees a on a.id = ja.assignee_id where ja.job_id = p_job and ja.role = 'project_manager' and a.user_id = auth.uid()) $f$;
revoke execute on function public.is_job_pm(uuid) from public, anon;
grant execute on function public.is_job_pm(uuid) to authenticated;

create or replace function public.pm_can_assign(p_job uuid, p_role text, p_assignee uuid) returns boolean language sql stable security definer set search_path to 'public' as $f$ select public.is_job_pm(p_job) and p_role <> 'project_manager' and exists (select 1 from public.assignee_roles r where r.key = p_role) and exists (select 1 from public.assignees a where a.id = p_assignee and a.active and a.role = p_role) $f$;
revoke execute on function public.pm_can_assign(uuid, text, uuid) from public, anon;
grant execute on function public.pm_can_assign(uuid, text, uuid) to authenticated;

create policy job_assignments_pm_insert on public.job_assignments for insert to authenticated with check (public.pm_can_assign(job_id, role, assignee_id));
create policy job_assignments_pm_crew_update on public.job_assignments for update to authenticated using (public.is_job_pm(job_id) and role <> 'project_manager') with check (public.pm_can_assign(job_id, role, assignee_id));
create policy job_assignments_pm_delete on public.job_assignments for delete to authenticated using (public.is_job_pm(job_id) and role <> 'project_manager');

create or replace function public.guard_assignment_columns() returns trigger language plpgsql security definer set search_path to 'public' as $function$ begin if auth.uid() is null or public.is_admin() then return new; end if; if new.job_id is distinct from old.job_id then raise exception 'assignments cannot be moved to another job' using errcode = '42501'; end if; if old.role <> 'project_manager' and public.is_job_pm(old.job_id) then return new; end if; if (new.assignee_id, new.role) is distinct from (old.assignee_id, old.role) then raise exception 'your account can only change the dates and note on this assignment' using errcode = '42501'; end if; return new; end; $function$;;
