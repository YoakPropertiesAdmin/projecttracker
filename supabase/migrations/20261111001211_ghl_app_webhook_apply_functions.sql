-- New 3-arg ghl_sync_opportunities(records, run_id, prune), built from the live
-- 2-arg definition with exactly two asserted edits. The 2-arg function then
-- becomes a pass-through with prune = true, so the sweep is unchanged and the
-- logic exists once.
do $mig$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.ghl_sync_opportunities(jsonb,uuid)'::regprocedure);
  d2 := replace(d, 'p_run_id uuid DEFAULT NULL::uuid)', 'p_run_id uuid, p_prune boolean)');
  if d2 = d then raise exception 'signature edit did not apply'; end if;
  d := d2;
  d2 := replace(d, 'if jsonb_array_length(p_records) > 0 then', 'if p_prune and jsonb_array_length(p_records) > 0 then');
  if d2 = d then raise exception 'prune edit did not apply'; end if;
  execute d2;
end
$mig$;

create or replace function public.ghl_sync_opportunities(p_records jsonb, p_run_id uuid default null)
returns jsonb
language sql security definer set search_path = ''
as $$ select public.ghl_sync_opportunities(p_records, p_run_id, true) $$;

revoke all on function public.ghl_sync_opportunities(jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.ghl_sync_opportunities(jsonb, uuid, boolean) to service_role;

create or replace function public.ghl_apply_opportunity_event(p_record jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_opp text := p_record ->> 'opportunity_id'; v_exists boolean; v_res jsonb;
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
  return v_res || jsonb_build_object('applied', true,
    'job_id', (select id from public.jobs where ghl_opportunity_id = v_opp));
end $$;

create or replace function public.ghl_apply_contact_event(p_contact_id text, p_email text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  update public.jobs set
    customer_email = coalesce(nullif(btrim(p_email), ''), customer_email),
    customer_phone = coalesce(nullif(btrim(p_phone), ''), customer_phone)
  where ghl_contact_id = p_contact_id
    and (customer_email is distinct from coalesce(nullif(btrim(p_email), ''), customer_email)
      or customer_phone is distinct from coalesce(nullif(btrim(p_phone), ''), customer_phone));
  get diagnostics n = row_count;
  return jsonb_build_object('jobs_updated', n,
    'jobs_linked', (select count(*) from public.jobs where ghl_contact_id = p_contact_id));
end $$;

revoke all on function public.ghl_apply_opportunity_event(jsonb) from public, anon, authenticated;
revoke all on function public.ghl_apply_contact_event(text, text, text) from public, anon, authenticated;
grant execute on function public.ghl_apply_opportunity_event(jsonb) to service_role;
grant execute on function public.ghl_apply_contact_event(text, text, text) to service_role;
;
