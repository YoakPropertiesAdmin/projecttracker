-- ---------------------------------------------------------------------------
-- Columns the GHL mapping needs
-- ---------------------------------------------------------------------------

alter table public.jobs
  add column if not exists ghl_project_display_id text,
  -- Scheduled remaining amount as GHL knows it. Deliberately NOT a payment:
  -- nobody has paid it at contract-signing time. Kept for reconciliation only.
  add column if not exists expected_final_payment numeric(12,2);

-- The idempotency key. A redelivered webhook matches the existing job and
-- updates it; without this a retry silently creates a duplicate job with a
-- split payment ledger.
create unique index if not exists idx_jobs_ghl_display_id
  on public.jobs (ghl_project_display_id) where ghl_project_display_id is not null;

-- Lets a payment row be traced back to the delivery that created it, and makes
-- re-running a mapping update that row instead of double-booking the deposit.
alter table public.client_payments add column if not exists source_ref text;
create unique index if not exists idx_client_payments_source
  on public.client_payments (job_id, source_ref) where source_ref is not null;

alter table public.ghl_inbound add column if not exists warnings text[];

-- ---------------------------------------------------------------------------
-- GHL pipeline stage -> TradeDesk stage
-- ---------------------------------------------------------------------------
-- A table rather than a CASE inside the function: adding or correcting a
-- mapping is one INSERT, no redeploy. An unmapped name is not an error — the
-- job lands at 'signed' and the delivery is flagged, because losing a signed
-- contract over a renamed pipeline stage would be a bad trade.
create table if not exists public.ghl_stage_map (
  ghl_stage_name text primary key,
  td_stage       text not null,
  created_at     timestamptz not null default now()
);

alter table public.ghl_stage_map enable row level security;
revoke all on public.ghl_stage_map from anon;

drop policy if exists ghl_stage_map_read on public.ghl_stage_map;
create policy ghl_stage_map_read on public.ghl_stage_map
  for select to authenticated using (true);
drop policy if exists ghl_stage_map_write on public.ghl_stage_map;
create policy ghl_stage_map_write on public.ghl_stage_map
  for all to authenticated using (true) with check (true);

-- Seeded with the obvious guesses; real pipeline names get added once Joshua
-- sends them. Matching is case-insensitive on the caller side.
insert into public.ghl_stage_map (ghl_stage_name, td_stage) values
  ('contract signed','signed'),
  ('sold','signed'),
  ('won','signed'),
  ('permitting','permitting'),
  ('permitting & measure','permitting'),
  ('measure','permitting'),
  ('materials ordered','materials_ordered'),
  ('scheduled','scheduled'),
  ('in progress','in_progress'),
  ('punch list','punch_list'),
  ('completed','completed'),
  ('closed','closed'),
  ('closed / paid','closed'),
  ('paid','closed')
on conflict (ghl_stage_name) do nothing;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- GHL renders an unresolved merge field as the four-character string 'null',
-- so an empty field arrives looking like data. Everything goes through here.
create or replace function public.ghl_text(p jsonb, k text)
returns text language sql immutable set search_path = '' as $$
  select nullif(nullif(btrim(coalesce(p ->> k, '')), ''), 'null');
$$;

-- '$14,200.00' / '14200' / null -> numeric
create or replace function public.ghl_money(p jsonb, k text)
returns numeric language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(public.ghl_text(p, k), '[^0-9.\-]', '', 'g'), '')::numeric;
$$;

-- ---------------------------------------------------------------------------
-- the mapper
-- ---------------------------------------------------------------------------
-- Lives in the database, not the edge function, so replaying a stored delivery
-- is `select public.map_ghl_inbound('<id>')` — no HTTP, no redeploy. The edge
-- function captures and then calls this; if it fails, the raw delivery is still
-- safely in ghl_inbound and can be re-run once the cause is fixed.
create or replace function public.map_ghl_inbound(p_inbound_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec        public.ghl_inbound%rowtype;
  p          jsonb;
  v_display  text;
  v_stage_in text;
  v_stage    text;
  v_trade    text;
  v_contract numeric;
  v_deposit  numeric;
  v_final    numeric;
  v_calc     numeric;
  v_job_id   uuid;
  v_balance  numeric;
  warn       text[] := '{}';
begin
  select * into rec from public.ghl_inbound where id = p_inbound_id;
  if not found then
    raise exception 'no ghl_inbound row %', p_inbound_id;
  end if;
  p := rec.payload;

  v_display := public.ghl_text(p, 'opportunity project display id');
  if v_display is null then
    update public.ghl_inbound
       set error = 'no project display id — cannot match this delivery to a job',
           warnings = null
     where id = p_inbound_id;
    return jsonb_build_object('mapped', false, 'reason', 'missing project display id');
  end if;

  -- stage
  v_stage_in := public.ghl_text(p, 'opportunity stage name');
  if v_stage_in is null then
    v_stage := 'signed';
    warn := warn || 'no stage name in payload; defaulted to signed';
  else
    select td_stage into v_stage from public.ghl_stage_map
     where ghl_stage_name = lower(btrim(v_stage_in));
    if v_stage is null then
      v_stage := 'signed';
      warn := warn || ('unmapped GHL stage ' || quote_literal(v_stage_in) ||
                       '; defaulted to signed — add it to ghl_stage_map');
    end if;
  end if;

  -- trade
  v_trade := lower(coalesce(public.ghl_text(p, 'opportunity opportunity project type'),
                            public.ghl_text(p, 'opportunity project type'), ''));
  if v_trade not in ('roofing','siding','windows','doors') then
    if v_trade <> '' then
      warn := warn || ('unrecognised project type ' || quote_literal(v_trade) || '; stored as-is');
    else
      v_trade := 'roofing';
      warn := warn || 'no project type in payload; defaulted to roofing';
    end if;
  end if;

  v_contract := coalesce(public.ghl_money(p, 'opportunity lead value'), 0);
  v_deposit  := public.ghl_money(p, 'opportunity initial deposit');
  v_final    := public.ghl_money(p, 'opportunity final payment');
  v_calc     := public.ghl_money(p, 'opportunity calculatedtotal');

  -- upsert the job on the display id
  insert into public.jobs (
    customer_name, customer_phone, customer_email, customer_address,
    trade, stage, contract_amount, notes,
    ghl_project_display_id, expected_final_payment, start_date
  ) values (
    coalesce(public.ghl_text(p, 'name'), 'Unnamed customer'),
    coalesce(public.ghl_text(p, 'phone'), ''),
    coalesce(public.ghl_text(p, 'email'), ''),
    coalesce(public.ghl_text(p, 'opportunity address'), ''),
    v_trade, v_stage, v_contract,
    coalesce(public.ghl_text(p, 'opportunity name'), ''),
    v_display, v_final, rec.received_at
  )
  on conflict (ghl_project_display_id) where ghl_project_display_id is not null
  do update set
    customer_name          = excluded.customer_name,
    customer_phone         = excluded.customer_phone,
    customer_email         = excluded.customer_email,
    customer_address       = excluded.customer_address,
    trade                  = excluded.trade,
    stage                  = excluded.stage,
    contract_amount        = excluded.contract_amount,
    expected_final_payment = excluded.expected_final_payment
  returning id into v_job_id;

  -- The deposit is money actually collected, so it becomes a ledger row.
  -- source_ref makes a replay update this row rather than book it twice.
  if v_deposit is not null and v_deposit > 0 then
    insert into public.client_payments (job_id, amount, payment_date, method, note, source_ref)
    values (v_job_id, v_deposit, rec.received_at, 'Check', 'Initial deposit (from GoHighLevel)', 'ghl:deposit')
    on conflict (job_id, source_ref) where source_ref is not null
    do update set amount = excluded.amount;
  end if;

  -- calculatedtotal is GHL's view of what is still owed. TradeDesk derives the
  -- same figure from the ledger, so this is a cross-check, not a stored value:
  -- a mismatch means a payment exists in one system and not the other.
  if v_calc is not null then
    select balance_due into v_balance from public.job_financials where job_id = v_job_id;
    if abs(v_balance - v_calc) > 0.01 then
      warn := warn || ('balance mismatch: GHL says ' || v_calc ||
                       ', ledger says ' || v_balance || ' — check for a payment recorded in only one system');
    end if;
  end if;

  update public.ghl_inbound
     set processed_at = now(),
         job_id       = v_job_id,
         error        = null,
         warnings     = nullif(warn, '{}')
   where id = p_inbound_id;

  return jsonb_build_object(
    'mapped', true, 'job_id', v_job_id, 'display_id', v_display,
    'stage', v_stage, 'trade', v_trade, 'contract_amount', v_contract,
    'warnings', to_jsonb(warn));
exception when others then
  update public.ghl_inbound set error = sqlerrm where id = p_inbound_id;
  return jsonb_build_object('mapped', false, 'reason', sqlerrm);
end;
$$;

revoke all on function public.map_ghl_inbound(uuid) from public, anon;
grant execute on function public.map_ghl_inbound(uuid) to authenticated;;
