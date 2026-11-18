-- `warn || 'a' || 'b'` let Postgres resolve the first || as array||array and try
-- to cast the untyped literal to text[], throwing "malformed array literal" —
-- which the handler caught and rolled the whole delivery back, losing a real
-- job creation over a cosmetic warning string. Parenthesised and cast, so the
-- inner concat is unambiguously text before it ever meets the array.

create or replace function public.map_ghl_inbound(p_inbound_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  rec public.ghl_inbound%rowtype;
  p jsonb;
  v_opp text; v_display text; v_stage_in text; v_stage text; v_flag text;
  v_trade_raw text; v_trade text; v_trades text[]; v_repair boolean := false;
  v_lead numeric; v_signed numeric; v_contract numeric; v_src text;
  v_calc numeric; v_collected numeric;
  v_job_id uuid; v_pay jsonb; warn text[] := '{}';
  v_dupes int; v_matched text := 'new';
begin
  select * into rec from public.ghl_inbound where id = p_inbound_id;
  if not found then raise exception 'no ghl_inbound row %', p_inbound_id; end if;
  p := rec.payload;

  -- The payload's bare "id" is the CONTACT id and must never be used as the
  -- opportunity key; several opportunities can share one contact.
  v_opp := coalesce(
    public.ghl_text(p, 'opportunity id'),
    public.ghl_text(p, 'opportunity_id'),
    public.ghl_text(p, 'opportunity opportunity id'));
  v_display := public.ghl_text(p, 'opportunity project display id');

  if v_opp is null and v_display is null then
    update public.ghl_inbound
       set error = 'no opportunity id and no project display id — nothing to match this delivery to. '
                || 'Add {{opportunity.id}} to the workflow payload.',
           warnings = null
     where id = p_inbound_id;
    return jsonb_build_object('mapped', false, 'reason', 'no identity in payload');
  end if;

  -- Serialise concurrent deliveries for the same opportunity so two webhooks
  -- firing together cannot both insert.
  perform pg_advisory_xact_lock(hashtext(coalesce(v_opp, 'display:' || v_display)));

  v_stage_in := public.ghl_text(p, 'opportunity stage name');
  if v_stage_in is null then
    v_stage := 'signed';
    warn := warn || ('no stage name in payload; defaulted to signed')::text;
  else
    select td_stage, flag into v_stage, v_flag from public.ghl_stage_map
     where ghl_stage_name = lower(btrim(v_stage_in));
    if v_stage is null then
      v_stage := 'signed';
      warn := warn || ('unmapped GHL stage ' || quote_literal(v_stage_in) ||
                       '; defaulted to signed — add it to ghl_stage_map')::text;
    end if;
  end if;

  v_trade_raw := coalesce(public.ghl_text(p, 'opportunity opportunity project type'),
                          public.ghl_text(p, 'opportunity project type'));
  if v_trade_raw is null then
    v_trade  := coalesce((select key from public.trades where active and key <> 'combo' order by sort_order limit 1), 'roofing');
    v_trades := array[v_trade];
    warn := warn || ('no project type in payload; defaulted to ' || v_trade)::text;
  else
    v_repair := public.match_is_repair(v_trade_raw);
    v_trades := public.match_trades(v_trade_raw);
    if cardinality(v_trades) = 0 then
      v_trade := public.resolve_trade(v_trade_raw);
      if v_trade is null then
        v_trade  := lower(btrim(v_trade_raw));
        v_trades := array[v_trade];
        warn := warn || ('unknown project type ' || quote_literal(v_trade_raw) ||
                         ' — job created with it as-is; add a keyword in public.trade_keywords')::text;
      else
        v_trades := array[v_trade];
      end if;
    elsif cardinality(v_trades) = 1 then
      v_trade := v_trades[1];
    else
      v_trade := 'combo';
    end if;
  end if;

  -- lead_value is the field the office maintains as the job's total value and is
  -- populated on essentially every delivery. total_signed_value is a fallback so
  -- a job still lands with a figure rather than zero.
  v_lead   := public.ghl_money(p, 'opportunity lead value');
  v_signed := public.ghl_money(p, 'opportunity total signed value');
  v_contract := coalesce(v_lead, v_signed, 0);
  v_src := case when v_lead is not null then 'lead_value'
                when v_signed is not null then 'total_signed_value'
                else 'none' end;
  if v_lead is null and v_signed is not null then
    warn := warn || ('no lead value in payload; used total signed value as the contract amount')::text;
  elsif v_contract = 0 then
    warn := warn || ('no contract amount in payload; job created at $0')::text;
  end if;

  -- 1. native opportunity id
  if v_opp is not null then
    select id into v_job_id from public.jobs where ghl_opportunity_id = v_opp;
    if v_job_id is not null then v_matched := 'opportunity_id'; end if;
  end if;

  -- 2. project display id, which is not unique here
  if v_job_id is null and v_display is not null then
    select count(*) into v_dupes from public.jobs where ghl_project_display_id = v_display;
    if v_dupes > 1 then
      warn := warn || (v_dupes || ' jobs share display id ' || v_display ||
                       ' — matched the lowest job number; send {{opportunity.id}} to remove the ambiguity')::text;
    end if;
    select id into v_job_id from public.jobs
     where ghl_project_display_id = v_display
     order by number limit 1;
    if v_job_id is not null then v_matched := 'display_id'; end if;
  end if;

  if v_job_id is null then
    insert into public.jobs (
      customer_name, customer_phone, customer_email, customer_address,
      trade, trades, is_repair, stage, substage, flag, contract_amount, notes,
      ghl_opportunity_id, ghl_project_display_id, ghl_status, start_date
    ) values (
      coalesce(public.ghl_text(p, 'name'), 'Unnamed customer'),
      coalesce(public.ghl_text(p, 'phone'), ''),
      coalesce(public.ghl_text(p, 'email'), ''),
      coalesce(public.ghl_text(p, 'opportunity address'), ''),
      v_trade, v_trades, v_repair, v_stage, v_stage_in, v_flag, v_contract,
      coalesce(public.ghl_text(p, 'opportunity name'), ''),
      v_opp, v_display, 'open', rec.received_at
    )
    returning id into v_job_id;
    if v_opp is null then
      warn := warn || ('job created without a GHL opportunity id — the nightly sweep will adopt it '
                    || 'by name; add {{opportunity.id}} to the workflow so it is keyed immediately')::text;
    end if;
  else
    update public.jobs set
      -- Stamp the opportunity id the first time a delivery carries one, so a job
      -- that arrived by webhook becomes properly keyed without waiting for the sweep.
      ghl_opportunity_id     = coalesce(v_opp, ghl_opportunity_id),
      ghl_project_display_id = coalesce(v_display, ghl_project_display_id),
      customer_name    = coalesce(public.ghl_text(p, 'name'), customer_name),
      customer_phone   = coalesce(public.ghl_text(p, 'phone'), customer_phone),
      customer_email   = coalesce(public.ghl_text(p, 'email'), customer_email),
      customer_address = coalesce(public.ghl_text(p, 'opportunity address'), customer_address),
      trade = v_trade, trades = v_trades, is_repair = v_repair,
      stage = v_stage, substage = v_stage_in, flag = v_flag,
      contract_amount = v_contract
    where id = v_job_id;
  end if;

  -- Each registered payment field becomes its own ledger row: changing a value
  -- in the CRM updates that row, clearing it removes it. Payments entered
  -- directly in TradeDesk carry no source_ref and are never touched, so the CRM
  -- never limits what the office can record.
  v_pay := public.ghl_apply_payments(v_job_id, p, rec.received_at);

  v_calc := public.ghl_money(p, 'opportunity calculatedtotal');
  if v_calc is not null and v_contract > 0 then
    select client_received into v_collected from public.job_financials where job_id = v_job_id;
    if abs((v_contract - v_calc) - v_collected) > 0.01 then
      warn := warn || ('balance mismatch: GHL implies ' || (v_contract - v_calc) ||
                       ' collected, ledger has ' || v_collected ||
                       ' — check for a payment recorded in only one system')::text;
    end if;
  end if;

  update public.ghl_inbound
     set processed_at = now(), job_id = v_job_id, error = null, warnings = nullif(warn, '{}')
   where id = p_inbound_id;

  return jsonb_build_object('mapped', true, 'job_id', v_job_id, 'matched_on', v_matched,
    'opportunity_id', v_opp, 'display_id', v_display,
    'stage', v_stage, 'substage', v_stage_in, 'flag', v_flag,
    'trade', v_trade, 'trades', to_jsonb(v_trades), 'is_repair', v_repair,
    'contract_amount', v_contract, 'contract_source', v_src,
    'payments', v_pay -> 'applied', 'warnings', to_jsonb(warn));
exception when others then
  update public.ghl_inbound set error = sqlerrm where id = p_inbound_id;
  return jsonb_build_object('mapped', false, 'reason', sqlerrm);
end;
$function$;

revoke execute on function public.map_ghl_inbound(uuid) from public, anon, authenticated;;
