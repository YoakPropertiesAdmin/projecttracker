-- Pulled from production (supabase_migrations.schema_migrations) on 2026-11-23;
-- it was applied there on 2026-11-18 but missing from the repo.
do $d$
declare s text; n text;
begin
  s := pg_get_functiondef('public.guard_job_columns'::regproc);
  n := replace(replace(s,
        'old.trade_locked, old.status_locked, old.paid_status)',
        'old.trade_locked, old.status_locked, old.paid_status, old.job_type)'),
        'new.trade_locked, new.status_locked, new.paid_status)',
        'new.trade_locked, new.status_locked, new.paid_status, new.job_type)');
  if n = s then raise exception 'guard_job_columns: no match'; end if;
  execute n;

  s := pg_get_functiondef('public.report_booked_by_type'::regproc);
  n := replace(s, 'and contract_signed_date between v_from and v_to)',
                  'and date_trunc(''month'', contract_signed_date) between v_from and date_trunc(''month'', v_to::timestamp))');
  if n = s then raise exception 'report_booked_by_type: no match'; end if;
  execute n;
end $d$;
