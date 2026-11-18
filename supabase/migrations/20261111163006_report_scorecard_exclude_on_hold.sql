-- Joshua, 2026-11-11: jobs flagged On hold are not booked sales. They drop out of
-- the scorecard while on hold and return when the flag is cleared.
do $mig$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.report_monthly_scorecard(date,date)'::regprocedure);
  d2 := replace(d,
    'live as (select * from public.jobs where coalesce(ghl_status, '''') not in (''lost'', ''abandoned''))',
    'live as (select * from public.jobs where coalesce(ghl_status, '''') not in (''lost'', ''abandoned'') and coalesce(flag, '''') <> ''on_hold'')');
  if d2 = d then raise exception 'edit did not apply'; end if;
  execute d2;
end
$mig$;;
