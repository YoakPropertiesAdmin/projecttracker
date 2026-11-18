create or replace function public.map_ghl_inbound(p_inbound_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.ghl_inbound%rowtype;
  p jsonb;
  v_display text; v_stage_in text; v_stage text; v_flag text;
  v_trade_raw text; v_trade text; v_trades text[]; v_repair boolean := false;
  v_signed numeric; v_lead numeric; v_contract numeric;
  v_calc numeric; v_collected numeric;
  v_job_id uuid; v_pay jsonb; warn text[] := '{}';
begin
  select * into rec from public.ghl_inbound where id = p_inbound_id;
  if not found then raise exception 'no ghl_inbound row %', p_inbound_id; end if;
  p := rec.payload;

  v_display := public.ghl_text(p, 'opportunity project display id');
  if v_display is null then
    update public.ghl_inbound
       set error = 'no project display id — cannot match this delivery to a job', warnings = null
     where id = p_inbound_id;
    return jsonb_build_object('mapped', false, 'reason', 'missing project display id');
  end if;

  v_stage_in := public.ghl_text(p, 'opportunity stage name');
  if v_stage_in is null then
    v_stage := 'signed';
    warn := warn || 'no stage name in payload; defaulted to signed';
  else
    select td_stage, flag into v_stage, v_flag from public.ghl_stage_map
     where ghl_stage_name = lower(btrim(v_stage_in));
    if v_stage is null then
      v_stage := 'signed';
      warn := warn || ('unmapped GHL stage ' || quote_literal(v_stage_in) ||
                       '; defaulted to signed — add it to ghl_stage_map');
    end if;
  end if;

  v_trade_raw := coalesce(public.ghl_text(p, 'opportunity opportunity project type'),
                          public.ghl_text(p, 'opportunity project type'));
  if v_trade_raw is null then
    v_trade  := coalesce((select key from public.trades where active and key <> 'combo' order by sort_order limit 1), 'roofing');
    v_trades := array[v_trade];
    warn := warn || ('no project type in payload; defaulted to ' || v_trade);
  else
    v_repair := public.match_is_repair(v_trade_raw);
    v_trades := public.match_trades(v_trade_raw);
    if cardinality(v_trades) = 0 then
      v_trade := public.resolve_trade(v_trade_raw);
      if v_trade is null then
        v_trade  := lower(btrim(v_trade_raw));
        v_trades := array[v_trade];
        warn := warn || ('unknown project type ' || quote_literal(v_trade_raw) ||
                         ' — job created with it as-is; add a keyword in public.trade_keywords');
      else
        v_trades := array[v_trade];
      end if;
    elsif cardinality(v_trades) = 1 then
      v_trade := v_trades[1];
    else
      v_trade := 'combo';
    end if;
  end if;

  -- Contract: total_signed_value is the value at signing and is what the
  -- ledger should be measured against. lead value is the pre-sale figure, kept
  -- as a fallback only so a job still lands if the signed field is absent.
  v_signed := public.ghl_money(p, 'opportunity total signed value');
  v_lead   := public.ghl_money(p, 'opportunity lead value');
  v_contract := coalesce(v_signed, v_lead, 0);
  if v_signed is null and v_lead is not null then
    warn := warn || 'no total signed value in payload; used lead value as the contract amount';
  end if;

  insert into public.jobs (
    customer_name, customer_phone, customer_email, customer_address,
    trade, trades, is_repair, stage, substage, flag, contract_amount, notes,
    ghl_project_display_id, start_date
  ) values (
    coalesce(public.ghl_text(p, 'name'), 'Unnamed customer'),
    coalesce(public.ghl_text(p, 'phone'), ''),
    coalesce(public.ghl_text(p, 'email'), ''),
    coalesce(public.ghl_text(p, 'opportunity address'), ''),
    v_trade, v_trades, v_repair, v_stage, v_stage_in, v_flag, v_contract,
    coalesce(public.ghl_text(p, 'opportunity name'), ''),
    v_display, rec.received_at
  )
  on conflict (ghl_project_display_id) where ghl_project_display_id is not null
  do update set
    customer_name = excluded.customer_name, customer_phone = excluded.customer_phone,
    customer_email = excluded.customer_email, customer_address = excluded.customer_address,
    trade = excluded.trade, trades = excluded.trades, is_repair = excluded.is_repair,
    stage = excluded.stage, substage = excluded.substage, flag = excluded.flag,
    contract_amount = excluded.contract_amount
  returning id into v_job_id;

  -- Every registered payment field, applied as its own ledger row. Changing a
  -- value in the CRM updates that row; clearing it removes it. Payments entered
  -- directly in TradeDesk have no source_ref and are left alone, so the CRM
  -- never limits what the office can record.
  v_pay := public.ghl_apply_payments(v_job_id, p, rec.received_at);

  -- calculatedtotal is GHL's own remaining balance. Where it is present it is a
  -- free cross-check against the ledger; a mismatch means a payment exists in
  -- one system and not the other.
  v_calc := public.ghl_money(p, 'opportunity calculatedtotal');
  if v_calc is not null and v_contract > 0 then
    select client_received into v_collected from public.job_financials where job_id = v_job_id;
    if abs((v_contract - v_calc) - v_collected) > 0.01 then
      warn := warn || ('balance mismatch: GHL implies ' || (v_contract - v_calc) ||
                       ' collected, ledger has ' || v_collected ||
                       ' — check for a payment recorded in only one system');
    end if;
  end if;

  update public.ghl_inbound
     set processed_at = now(), job_id = v_job_id, error = null, warnings = nullif(warn, '{}')
   where id = p_inbound_id;

  return jsonb_build_object('mapped', true, 'job_id', v_job_id, 'display_id', v_display,
    'stage', v_stage, 'substage', v_stage_in, 'flag', v_flag,
    'trade', v_trade, 'trades', to_jsonb(v_trades), 'is_repair', v_repair,
    'contract_amount', v_contract, 'contract_source',
      case when v_signed is not null then 'total_signed_value' else 'lead_value' end,
    'payments', v_pay -> 'applied', 'warnings', to_jsonb(warn));
exception when others then
  update public.ghl_inbound set error = sqlerrm where id = p_inbound_id;
  return jsonb_build_object('mapped', false, 'reason', sqlerrm);
end;
$$;

revoke execute on function public.map_ghl_inbound(uuid) from authenticated, anon, public;;
