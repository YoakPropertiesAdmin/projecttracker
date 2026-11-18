create or replace function public.ghl_sync_opportunities(p_records jsonb, p_run_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r jsonb;
  v_stage text; v_flag text; v_exclude boolean;
  v_trade text; v_trades text[]; v_repair boolean;
  v_contract numeric; v_status text; v_stage_in text; v_type text;
  v_job_id uuid; v_existing uuid; v_prev_status text;
  v_created int := 0; v_updated int := 0; v_skipped int := 0;
  v_changes jsonb := '[]'::jsonb;
  v_notes text[] := '{}';
  v_started timestamptz := clock_timestamp();
  v_pruned int := 0;
begin
  for r in select * from jsonb_array_elements(p_records) loop
    v_stage_in := nullif(btrim(coalesce(r ->> 'stage_name', '')), '');
    v_status   := lower(coalesce(nullif(r ->> 'status', ''), 'open'));

    -- Stage, marker and exclusion all come from the one lookup table.
    select td_stage, flag, exclude into v_stage, v_flag, v_exclude
      from public.ghl_stage_map where ghl_stage_name = lower(btrim(coalesce(v_stage_in, '')));

    if coalesce(v_exclude, false) then
      v_skipped := v_skipped + 1;
      -- Leave the skip behind so the exclusion is auditable rather than silent.
      insert into public.ghl_ignored_opportunities as g (
        opportunity_id, display_id, name, stage_name, ghl_status,
        monetary_value, address, phone, email, last_seen_at)
      values (
        r ->> 'opportunity_id', nullif(r ->> 'display_id', ''), nullif(r ->> 'name', ''),
        v_stage_in, v_status,
        coalesce((r ->> 'signed_value')::numeric, (r ->> 'monetary_value')::numeric),
        nullif(r ->> 'address', ''), nullif(r ->> 'phone', ''), nullif(r ->> 'email', ''),
        v_started)
      on conflict (opportunity_id) do update set
        display_id     = coalesce(excluded.display_id, g.display_id),
        name           = coalesce(excluded.name, g.name),
        stage_name     = excluded.stage_name,
        ghl_status     = excluded.ghl_status,
        monetary_value = excluded.monetary_value,
        address        = coalesce(excluded.address, g.address),
        phone          = coalesce(excluded.phone, g.phone),
        email          = coalesce(excluded.email, g.email),
        last_seen_at   = excluded.last_seen_at;
      continue;
    end if;

    if v_stage is null then
      v_stage := 'signed';
      v_notes := v_notes || ('unmapped stage ' || quote_literal(coalesce(v_stage_in, '(none)')) ||
                             ' — defaulted to signed');
    end if;

    -- Project type through the keyword matcher, same as the webhook path.
    v_type := nullif(btrim(coalesce(r ->> 'project_type', '')), '');
    v_repair := coalesce(public.match_is_repair(v_type), false);
    v_trades := coalesce(public.match_trades(v_type), '{}');
    if cardinality(v_trades) = 0 then
      v_trade := public.resolve_trade(v_type);
      if v_trade is null then
        v_trade := coalesce(lower(v_type),
                            (select key from public.trades where active and key <> 'combo' order by sort_order limit 1),
                            'roofing');
      end if;
      v_trades := array[v_trade];
    elsif cardinality(v_trades) = 1 then
      v_trade := v_trades[1];
    else
      v_trade := 'combo';
    end if;

    -- monetaryValue is populated on every record; Total Signed Value only
    -- sometimes, so it overrides rather than leads.
    v_contract := coalesce((r ->> 'signed_value')::numeric, (r ->> 'monetary_value')::numeric, 0);

    select id, ghl_status into v_existing, v_prev_status from public.jobs
     where ghl_opportunity_id = (r ->> 'opportunity_id');

    if v_existing is null and nullif(r ->> 'display_id', '') is not null then
      select id, ghl_status into v_existing, v_prev_status from public.jobs
       where ghl_project_display_id = (r ->> 'display_id')
         and ghl_opportunity_id is null
       order by number limit 1;
    end if;

    if v_existing is null then
      insert into public.jobs (
        ghl_opportunity_id, ghl_project_display_id, ghl_status,
        customer_name, customer_phone, customer_email, customer_address,
        trade, trades, is_repair, stage, substage, flag, contract_amount, notes, start_date)
      values (
        r ->> 'opportunity_id', nullif(r ->> 'display_id', ''), v_status,
        coalesce(nullif(r ->> 'name', ''), 'Unnamed customer'),
        coalesce(r ->> 'phone', ''), coalesce(r ->> 'email', ''), coalesce(r ->> 'address', ''),
        v_trade, v_trades, v_repair, v_stage, v_stage_in, v_flag, v_contract,
        coalesce(r ->> 'notes', ''), coalesce((r ->> 'created_at')::timestamptz, now()))
      returning id into v_job_id;
      v_created := v_created + 1;
    else
      update public.jobs set
        ghl_opportunity_id = r ->> 'opportunity_id',
        ghl_project_display_id = coalesce(nullif(r ->> 'display_id', ''), ghl_project_display_id),
        ghl_status = v_status,
        customer_name = coalesce(nullif(r ->> 'name', ''), customer_name),
        customer_phone = coalesce(nullif(r ->> 'phone', ''), customer_phone),
        customer_email = coalesce(nullif(r ->> 'email', ''), customer_email),
        customer_address = coalesce(nullif(r ->> 'address', ''), customer_address),
        trade = v_trade, trades = v_trades, is_repair = v_repair,
        stage = v_stage, substage = v_stage_in, flag = v_flag,
        contract_amount = v_contract
      where id = v_existing
      returning id into v_job_id;
      v_updated := v_updated + 1;

      if v_prev_status is distinct from v_status then
        v_changes := v_changes || jsonb_build_object(
          'job_id', v_job_id, 'display_id', r ->> 'display_id',
          'from', v_prev_status, 'to', v_status);
      end if;
    end if;

    -- Payment fields reuse the webhook path, so there is one definition of how
    -- a GHL payment becomes a ledger row.
    perform public.ghl_apply_payments(
      v_job_id,
      jsonb_build_object(
        'opportunity initial deposit', r #>> '{payments,initial}',
        'opportunity second deposit',  r #>> '{payments,second}',
        'opportunity final payment',   r #>> '{payments,final}'),
      coalesce((r ->> 'updated_at')::timestamptz, now()));
  end loop;

  -- An opportunity that left the excluded stage is no longer ignored; drop it
  -- so the list only ever shows what this sweep actually skipped. Guarded on a
  -- non-empty payload so a degenerate run cannot wipe the table.
  if jsonb_array_length(p_records) > 0 then
    delete from public.ghl_ignored_opportunities where last_seen_at < v_started;
    get diagnostics v_pruned = row_count;
    if v_pruned > 0 then
      v_notes := v_notes || (v_pruned || ' previously-ignored opportunity(ies) no longer excluded');
    end if;
  end if;

  if p_run_id is not null then
    update public.ghl_sync_runs
       set created = v_created, updated = v_updated, skipped = v_skipped,
           status_changes = nullif(v_changes, '[]'::jsonb),
           notes = nullif(v_notes, '{}')
     where id = p_run_id;
  end if;

  return jsonb_build_object('created', v_created, 'updated', v_updated,
                            'skipped', v_skipped, 'status_changes', v_changes,
                            'notes', to_jsonb(v_notes));
end;
$function$;

revoke execute on function public.ghl_sync_opportunities(jsonb, uuid) from public, anon, authenticated;;
