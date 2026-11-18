-- $0 fill never applies to lost/abandoned jobs: a cancelled sale is $0 on purpose
-- (e.g. #1124, #1199 set to $0 from the Sales tab on 2026-11-11).
do $mig$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.ghl_apply_opportunity_event(jsonb)'::regprocedure);
  d2 := replace(d,
    'where ghl_opportunity_id = v_opp and coalesce(contract_amount, 0) = 0;',
    'where ghl_opportunity_id = v_opp and coalesce(contract_amount, 0) = 0'
    || chr(10) || '       and coalesce(ghl_status, ''open'') not in (''lost'', ''abandoned'');');
  if d2 = d then raise exception 'edit did not apply'; end if;
  execute d2;
end
$mig$;
revoke all on function public.ghl_apply_opportunity_event(jsonb) from public, anon, authenticated;
grant execute on function public.ghl_apply_opportunity_event(jsonb) to service_role;;
