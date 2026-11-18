-- Some markers mean "this one is not moving" — those jobs should sink to the
-- bottom of their column so the live work sits at the top where the eye lands.
-- A property of the marker rather than a hardcoded check for on_hold, so a
-- future marker can opt in with one row.
alter table public.job_flags add column if not exists demote boolean not null default false;

update public.job_flags set demote = true  where key = 'on_hold';
update public.job_flags set demote = false where key in ('materials_in','needs_ordered');

select key, label, demote from public.job_flags order by sort_order;;
