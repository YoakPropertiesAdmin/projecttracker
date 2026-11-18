-- $0 fill (Joshua, 2026-11-11): when someone updates an opportunity in GHL and the
-- TradeDesk job is still at exactly $0, take the GHL value (total signed value
-- field, else the opportunity value - same order the sweep uses at creation).
-- Webhook path only; the nightly sweep never does this. A job with any real
-- amount is never touched.
create or replace function public.ghl_apply_opportunity_event(p_record jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_opp text := p_record ->> 'opportunity_id'; v_exists boolean; v_res jsonb;
  v_csd date := nullif(p_record ->> 'contract_signed_date', '')::date;
  v_mod date := nullif(p_record ->> 'materials_ordered_date', '')::date;
  v_val numeric := coalesce(nullif((p_record ->> 'signed_value')::numeric, 0),
                            nullif((p_record ->> 'monetary_value')::numeric, 0));
  v_dates int := 0; v_filled int := 0;
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

  if v_val is not null and v_val > 0 then
    update public.jobs set contract_amount = v_val
     where ghl_opportunity_id = v_opp and coalesce(contract_amount, 0) = 0;
    get diagnostics v_filled = row_count;
  end if;

  return v_res || jsonb_build_object('applied', true, 'dates_updated', v_dates,
    'zero_value_filled', case when v_filled > 0 then v_val end,
    'job_id', (select id from public.jobs where ghl_opportunity_id = v_opp));
end $$;

revoke all on function public.ghl_apply_opportunity_event(jsonb) from public, anon, authenticated;
grant execute on function public.ghl_apply_opportunity_event(jsonb) to service_role;
;
