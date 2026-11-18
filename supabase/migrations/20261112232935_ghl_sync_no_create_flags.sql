-- One list for "a contract with no TradeDesk job" from every source (GHL sweep, GHL webhook, Sales sheet).
create table if not exists public.job_flags (
  id uuid primary key default gen_random_uuid(),
  source text not null,              -- ghl_sweep | ghl_webhook | sales_sheet
  kind text not null,                -- ghl_no_job | sheet_no_job
  ref text not null,                 -- opportunity id | sheet row key
  name text, amount numeric,
  detail jsonb, candidates jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz, resolution text,
  unique (kind, ref)
);
alter table public.job_flags enable row level security;
create policy job_flags_admin_read on public.job_flags for select to authenticated using (public.is_admin());
comment on table public.job_flags is 'Contracts (GHL opportunities, Sales-sheet rows) with no TradeDesk job. Only the GHL webhook creates jobs automatically; everything else flags here. Auto-resolves when linked.';

-- TradeDesk jobs with no GHL opportunity that could be the job for this contract.
create or replace function public.job_link_candidates(p_name text, p_amount numeric, p_display text)
returns jsonb language sql stable security definer set search_path = public as $f$
  select coalesce(jsonb_agg(c order by (c->>'name_match')::boolean desc, (c->>'amount_match')::boolean desc, (c->>'number')::bigint desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'job_id', j.id, 'number', j.number, 'name', j.customer_name, 'amount', j.contract_amount,
      'display_id', j.ghl_project_display_id, 'stage', j.stage, 'status', j.ghl_status,
      'name_match', norm_person(j.customer_name) = norm_person(p_name),
      'amount_match', abs(coalesce(j.contract_amount, 0) - coalesce(p_amount, 0)) <= greatest(1, 0.01 * coalesce(p_amount, 0)),
      'display_match', p_display is not null and norm_display_id(j.ghl_project_display_id) = norm_display_id(p_display)) c
    from jobs j
    where j.ghl_opportunity_id is null
      and (norm_person(j.customer_name) = norm_person(p_name)
           or (nullif(p_display, '') is not null and norm_display_id(j.ghl_project_display_id) = norm_display_id(p_display)))
    limit 8
  ) s;
$f$;
revoke all on function public.job_link_candidates(text, numeric, text) from public, anon, authenticated;

create or replace function public.ghl_sync_opportunities_core(p_records jsonb, p_run_id uuid, p_prune boolean, p_allow_create boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  r jsonb;
  v_stage text; v_flag text; v_exclude boolean;
  v_trade text; v_trades text[]; v_repair boolean;
  v_contract numeric; v_status text; v_stage_in text; v_type text; v_moves boolean;
  v_job_id uuid; v_existing uuid; v_prev_status text; v_locked boolean;
  v_created int := 0; v_updated int := 0; v_skipped int := 0; v_flagged int := 0; v_linked int := 0;
  v_changes jsonb := '[]'::jsonb;
  v_notes text[] := '{}';
  v_started timestamptz := clock_timestamp();
  v_pruned int := 0; v_resolved int := 0;
  v_ghl_created timestamptz;
  v_cands jsonb; v_strict jsonb;
begin
  for r in select * from jsonb_array_elements(p_records) loop
    v_stage_in := nullif(btrim(coalesce(r ->> 'stage_name', '')), '');
    v_status   := lower(coalesce(nullif(r ->> 'status', ''), 'open'));

    select td_stage, flag, exclude, moves_existing_job into v_stage, v_flag, v_exclude, v_moves
      from public.ghl_stage_map where ghl_stage_name = lower(btrim(coalesce(v_stage_in, '')));

    if coalesce(v_exclude, false) then
      v_skipped := v_skipped + 1;
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
      v_notes := v_notes || ('unmapped stage ' || quote_literal(coalesce(v_stage_in, '(none)')) || ' — defaulted to signed');
    end if;

    v_type := nullif(btrim(coalesce(r ->> 'project_type', '')), '');
    v_repair := coalesce(public.match_is_repair(v_type), false);
    v_trades := coalesce(public.match_trades(v_type), '{}');
    if cardinality(v_trades) = 0 then
      v_trade := public.resolve_trade(v_type);
      if v_trade is null then v_trade := coalesce(lower(v_type), 'other', 'roofing'); end if;
      v_trades := array[v_trade];
    elsif cardinality(v_trades) = 1 then
      v_trade := v_trades[1];
    else
      v_trade := 'combo';
    end if;

    v_contract := coalesce((r ->> 'signed_value')::numeric, (r ->> 'monetary_value')::numeric, 0);

    begin
      v_ghl_created := nullif(r ->> 'created_at', '')::timestamptz;
    exception when others then
      v_ghl_created := null;
    end;

    v_existing := null; v_prev_status := null; v_locked := false;
    select id, ghl_status, coalesce(status_locked, false) into v_existing, v_prev_status, v_locked from public.jobs
     where ghl_opportunity_id = (r ->> 'opportunity_id');

    if v_existing is null and nullif(r ->> 'display_id', '') is not null then
      select id, ghl_status, coalesce(status_locked, false) into v_existing, v_prev_status, v_locked from public.jobs
       where ghl_project_display_id = (r ->> 'display_id')
         and ghl_opportunity_id is null
       order by number limit 1;
    end if;

    if v_existing is null then
      v_cands := public.job_link_candidates(r ->> 'name', v_contract, nullif(r ->> 'display_id', ''));
      if p_allow_create then
        -- Link first: exactly one live job with the same name and amount (or a $0 job) and no opportunity yet.
        select coalesce(jsonb_agg(c), '[]'::jsonb) into v_strict from jsonb_array_elements(v_cands) c
         where (c ->> 'name_match')::boolean
           and ((c ->> 'amount_match')::boolean or coalesce((c ->> 'amount')::numeric, 0) = 0)
           and coalesce(c ->> 'status', 'open') not in ('lost', 'abandoned');
        if jsonb_array_length(v_strict) = 1 then
          select id, ghl_status, coalesce(status_locked, false) into v_existing, v_prev_status, v_locked
            from public.jobs where id = (v_strict -> 0 ->> 'job_id')::uuid;
          v_linked := v_linked + 1;
          v_notes := v_notes || ('linked opportunity ' || (r ->> 'opportunity_id') || ' to existing JOB-' || (v_strict -> 0 ->> 'number'));
        elsif exists (select 1 from jsonb_array_elements(v_cands) c where (c ->> 'name_match')::boolean) then
          -- Same customer already has job(s) without an opportunity but it is not a clean match: a person decides.
          insert into public.job_flags as f (source, kind, ref, name, amount, detail, candidates)
          values ('ghl_webhook', 'ghl_no_job', r ->> 'opportunity_id', r ->> 'name', v_contract,
                  jsonb_build_object('reason', 'possible existing job — not created', 'stage', v_stage_in, 'status', v_status,
                    'display_id', r ->> 'display_id', 'address', r ->> 'address', 'ghl_created_at', r ->> 'created_at'), v_cands)
          on conflict (kind, ref) do update set last_seen_at = now(), name = excluded.name, amount = excluded.amount,
            detail = excluded.detail, candidates = excluded.candidates, source = excluded.source, resolved_at = null, resolution = null;
          v_flagged := v_flagged + 1;
          continue;
        end if;
      else
        -- Sweep: never creates. Flag the contract for a person.
        insert into public.job_flags as f (source, kind, ref, name, amount, detail, candidates)
        values ('ghl_sweep', 'ghl_no_job', r ->> 'opportunity_id', r ->> 'name', v_contract,
                jsonb_build_object('reason', 'GHL contract with no TradeDesk job', 'stage', v_stage_in, 'status', v_status,
                  'display_id', r ->> 'display_id', 'address', r ->> 'address', 'ghl_created_at', r ->> 'created_at'), v_cands)
        on conflict (kind, ref) do update set last_seen_at = now(), name = excluded.name, amount = excluded.amount,
          detail = excluded.detail, candidates = excluded.candidates, resolved_at = null, resolution = null;
        v_flagged := v_flagged + 1;
        continue;
      end if;
    end if;

    if v_existing is null then
      insert into public.jobs (
        ghl_opportunity_id, ghl_project_display_id, ghl_status,
        customer_name, customer_phone, customer_email, customer_address,
        trade, trades, is_repair, stage, substage, flag, contract_amount, notes,
        start_date, ghl_created_at, ghl_contact_id)
      values (
        r ->> 'opportunity_id', nullif(r ->> 'display_id', ''), v_status,
        coalesce(nullif(r ->> 'name', ''), 'Unnamed customer'),
        coalesce(r ->> 'phone', ''), coalesce(r ->> 'email', ''), coalesce(r ->> 'address', ''),
        v_trade, v_trades, v_repair, v_stage, v_stage_in, v_flag, v_contract,
        coalesce(r ->> 'notes', ''), coalesce(v_ghl_created, now()), v_ghl_created, nullif(r ->> 'contact_id', ''))
      returning id into v_job_id;
      v_created := v_created + 1;
    else
      update public.jobs set
        ghl_opportunity_id = r ->> 'opportunity_id',
        ghl_project_display_id = coalesce(nullif(r ->> 'display_id', ''), ghl_project_display_id),
        ghl_contact_id = coalesce(nullif(r ->> 'contact_id', ''), ghl_contact_id),
        ghl_status = case when status_locked then ghl_status else v_status end,
        customer_name = coalesce(nullif(r ->> 'name', ''), customer_name),
        customer_phone = coalesce(nullif(r ->> 'phone', ''), customer_phone),
        customer_email = coalesce(nullif(r ->> 'email', ''), customer_email),
        customer_address = coalesce(nullif(r ->> 'address', ''), customer_address),
        /* TradeDesk owns the project type once locked, after the first deposit, or when GHL sends none. */
        trade = case when (trade_locked or v_type is null or exists (select 1 from public.client_payments cp where cp.job_id = public.jobs.id)) then trade else v_trade end,
        trades = case when (trade_locked or v_type is null or exists (select 1 from public.client_payments cp where cp.job_id = public.jobs.id)) then trades else v_trades end,
        is_repair = case when (trade_locked or v_type is null or exists (select 1 from public.client_payments cp where cp.job_id = public.jobs.id)) then is_repair else v_repair end,
        stage = case when coalesce(v_moves, false) then v_stage else stage end, substage = v_stage_in,
        flag = case when status_locked then flag else v_flag end,
        -- contract_amount deliberately NOT written: TradeDesk owns it once the job exists.
        ghl_created_at = coalesce(v_ghl_created, ghl_created_at)
      where id = v_existing
      returning id into v_job_id;
      v_updated := v_updated + 1;

      -- Status-locked jobs keep their status, so a differing GHL status is not a change.
      if v_prev_status is distinct from v_status and not v_locked then
        v_changes := v_changes || jsonb_build_object('job_id', v_job_id, 'display_id', r ->> 'display_id', 'from', v_prev_status, 'to', v_status);
      end if;
    end if;
  end loop;

  -- Close flags whose opportunity now has a job (linked by hand, or by the webhook).
  update public.job_flags f set resolved_at = now(), resolution = 'linked to JOB-' || j.number
    from public.jobs j
   where f.kind = 'ghl_no_job' and f.resolved_at is null and j.ghl_opportunity_id = f.ref;
  get diagnostics v_resolved = row_count;

  if p_prune and jsonb_array_length(p_records) > 0 then
    delete from public.ghl_ignored_opportunities where last_seen_at < v_started;
    get diagnostics v_pruned = row_count;
    if v_pruned > 0 then
      v_notes := v_notes || (v_pruned || ' previously-ignored opportunity(ies) no longer excluded');
    end if;
    -- A full sweep saw every open contract: flags it did not see are no longer open contracts.
    update public.job_flags set resolved_at = now(), resolution = 'no longer an open contract in GHL'
     where kind = 'ghl_no_job' and resolved_at is null and last_seen_at < v_started;
  end if;

  if v_flagged > 0 then v_notes := v_notes || (v_flagged || ' contract(s) with no TradeDesk job flagged'); end if;

  if p_run_id is not null then
    update public.ghl_sync_runs
       set created = v_created, updated = v_updated, skipped = v_skipped,
           status_changes = nullif(v_changes, '[]'::jsonb),
           notes = nullif(v_notes, '{}')
     where id = p_run_id;
  end if;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped,
                            'flagged', v_flagged, 'linked_existing', v_linked, 'flags_resolved', v_resolved,
                            'status_changes', v_changes, 'notes', to_jsonb(v_notes));
end;
$function$;
revoke all on function public.ghl_sync_opportunities_core(jsonb, uuid, boolean, boolean) from public, anon, authenticated;

-- The sweep's entry point: never creates jobs.
create or replace function public.ghl_sync_opportunities(p_records jsonb, p_run_id uuid, p_prune boolean)
 returns jsonb language sql security definer set search_path to '' as $f$
  select public.ghl_sync_opportunities_core(p_records, p_run_id, p_prune, false);
$f$;;
