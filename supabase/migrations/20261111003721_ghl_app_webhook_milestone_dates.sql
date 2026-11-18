-- Milestone dates from the app webhook. The edge function parses the two GHL
-- date custom fields to ISO dates and passes them in the record.
--   contract_signed_date   : filled only when the job has none (Sales tab owns it after)
--   materials_ordered_date : set when GHL has a date (GHL is its only source)
--   neither is ever cleared from GHL (API omits empty fields).
create or replace function public.ghl_apply_opportunity_event(p_record jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_opp text := p_record ->> 'opportunity_id'; v_exists boolean; v_res jsonb;
  v_csd date := nullif(p_record ->> 'contract_signed_date', '')::date;
  v_mod date := nullif(p_record ->> 'materials_ordered_date', '')::date;
  v_dates int := 0;
begin
  if v_opp is null then return jsonb_build_object('applied', false, 'reason', 'no opportunity_id'); end if;
  perform pg_advisory_xact_lock(hashtext(v_opp));

  select exists (select 1 from public.jobs where ghl_opportunity_id = v_opp)
      or (nullif(p_record ->> 'display_id', '') is not null and exists (
            select 1 from public.jobs where ghl_project_display_id = p_record ->> 'display_id'
                                         and ghl_opportunity_id is null))
    into v_exists;

  if not v_exists and lower(coalesce(p_record ->> 'status', 'open')) <> 'open' then
    return jsonb_build_object('applied', false, 'reason', 'no job and opportunity is not open');
  end if;

  v_res := public.ghl_sync_opportunities(jsonb_build_array(p_record), null::uuid, false);

  if v_csd is not null or v_mod is not null then
    update public.jobs set
      contract_signed_date   = coalesce(contract_signed_date, v_csd),
      materials_ordered_date = coalesce(v_mod, materials_ordered_date)
    where ghl_opportunity_id = v_opp
      and (contract_signed_date is distinct from coalesce(contract_signed_date, v_csd)
        or materials_ordered_date is distinct from coalesce(v_mod, materials_ordered_date));
    get diagnostics v_dates = row_count;
  end if;

  return v_res || jsonb_build_object('applied', true, 'dates_updated', v_dates,
    'job_id', (select id from public.jobs where ghl_opportunity_id = v_opp));
end $$;

revoke all on function public.ghl_apply_opportunity_event(jsonb) from public, anon, authenticated;
grant execute on function public.ghl_apply_opportunity_event(jsonb) to service_role;
;
