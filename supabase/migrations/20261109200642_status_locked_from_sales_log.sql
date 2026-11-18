alter table public.jobs add column if not exists status_locked boolean not null default false;
comment on column public.jobs.status_locked is 'True when the 2026 Sales Log decides this job''s status (Lost / Cancelled / Hold tabs). The GHL sweep and webhook then leave ghl_status and the marker (flag) alone.';
do $d$ declare s text; begin
s := pg_get_functiondef('public.ghl_sync_opportunities(jsonb,uuid)'::regprocedure);
s := replace(s, 'ghl_status = v_status,', 'ghl_status = case when status_locked then ghl_status else v_status end,');
s := replace(s, 'flag = v_flag', 'flag = case when status_locked then flag else v_flag end');
execute s;
s := pg_get_functiondef('public.map_ghl_inbound'::regproc);
s := replace(s, 'flag = v_flag', 'flag = case when status_locked then flag else v_flag end');
execute s;
end $d$;;
