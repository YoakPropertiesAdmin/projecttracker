do $d$ declare s text; begin
s := pg_get_functiondef('public.guard_job_columns()'::regprocedure);
s := replace(s, 'new.materials_ordered_date, new.number)', 'new.materials_ordered_date, new.number, new.group_id, new.trade_locked, new.status_locked)');
s := replace(s, 'old.materials_ordered_date, old.number)', 'old.materials_ordered_date, old.number, old.group_id, old.trade_locked, old.status_locked)');
execute s;
s := pg_get_functiondef('public.map_ghl_inbound'::regproc);
s := replace(s, 'where ghl_project_display_id = v_display
     order by number limit 1;', 'where ghl_project_display_id = v_display
       and (v_opp is null or ghl_opportunity_id is null) /* another opportunity on the same GHL project # becomes its own linked job, not an overwrite */
     order by number limit 1;');
execute s;
end $d$;
select position('new.group_id' in pg_get_functiondef('public.guard_job_columns()'::regprocedure))>0 guard_ok, position('becomes its own linked job' in pg_get_functiondef('public.map_ghl_inbound'::regproc))>0 inbound_ok;;
