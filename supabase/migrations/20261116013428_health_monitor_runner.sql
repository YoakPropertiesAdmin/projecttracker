create or replace function public.health_run_checks() returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  c record; v_rows jsonb; r jsonb; v_ref text; v_sev text;
  t0 timestamptz := clock_timestamp();
  v_checks int := 0; v_opened int := 0; v_resolved int := 0; v_n int;
  v_errors jsonb := '[]'::jsonb; v_seen text[];
  v_to text[]; v_min int; v_new jsonb; v_fixed jsonb; v_open_total int;
begin
  for c in select * from health_checks where enabled and check_key <> 'monitor_check_failed' order by check_key loop
    v_checks := v_checks + 1;
    v_seen := '{}';
    begin
      execute format('select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (%s) q', c.query) into v_rows;
    exception when others then
      v_errors := v_errors || jsonb_build_object('check', c.check_key, 'error', sqlerrm);
      continue; -- a broken check leaves its findings untouched
    end;
    for r in select * from jsonb_array_elements(v_rows) loop
      v_ref := coalesce(r->>'ref', '');
      v_sev := coalesce(r->>'severity', c.severity);
      v_seen := v_seen || v_ref;
      update health_findings
         set last_seen = now(), occurrences = occurrences + 1, detail = r->'detail',
             title = coalesce(r->>'title', c.label), severity = v_sev
       where check_key = c.check_key and ref = v_ref and resolved_at is null;
      if not found then
        insert into health_findings (check_key, ref, severity, title, detail)
        values (c.check_key, v_ref, v_sev, coalesce(r->>'title', c.label), r->'detail');
        v_opened := v_opened + 1;
      end if;
    end loop;
    update health_findings set resolved_at = now()
     where check_key = c.check_key and resolved_at is null and not (ref = any(v_seen));
    get diagnostics v_n = row_count;
    v_resolved := v_resolved + v_n;
  end loop;

  -- A check whose own query fails is itself a finding.
  if exists (select 1 from health_checks where check_key = 'monitor_check_failed' and enabled) then
    for r in select * from jsonb_array_elements(v_errors) loop
      update health_findings set last_seen = now(), occurrences = occurrences + 1, detail = r
       where check_key = 'monitor_check_failed' and ref = r->>'check' and resolved_at is null;
      if not found then
        insert into health_findings (check_key, ref, severity, title, detail)
        values ('monitor_check_failed', r->>'check', 'warn', 'Health check "' || (r->>'check') || '" could not run', r);
        v_opened := v_opened + 1;
      end if;
    end loop;
    update health_findings set resolved_at = now()
     where check_key = 'monitor_check_failed' and resolved_at is null
       and ref not in (select e->>'check' from jsonb_array_elements(v_errors) e);
    get diagnostics v_n = row_count;
    v_resolved := v_resolved + v_n;
  end if;

  -- Alert: newly opened findings at or above the minimum severity, and those findings once they clear.
  select array(select jsonb_array_elements_text(value)) into v_to from health_settings where key = 'alert_to';
  select case value #>> '{}' when 'error' then 2 when 'warn' then 1 else 0 end into v_min
    from health_settings where key = 'alert_min_severity';
  v_min := coalesce(v_min, 1);

  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'check', f.check_key, 'label', h.label, 'ref', f.ref,
           'severity', f.severity, 'title', f.title, 'detail', f.detail, 'first_seen', f.first_seen,
           'description', h.description) order by f.severity desc, f.first_seen), '[]'::jsonb)
    into v_new
    from health_findings f join health_checks h using (check_key)
   where f.resolved_at is null and f.notified_at is null
     and (case f.severity when 'error' then 2 when 'warn' then 1 else 0 end) >= v_min;

  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'check', f.check_key, 'label', h.label, 'ref', f.ref,
           'title', f.title, 'first_seen', f.first_seen, 'resolved_at', f.resolved_at) order by f.resolved_at), '[]'::jsonb)
    into v_fixed
    from health_findings f join health_checks h using (check_key)
   where f.resolved_at is not null and f.notified_at is not null and f.resolved_notified_at is null;

  select count(*) into v_open_total from health_findings where resolved_at is null;

  if (jsonb_array_length(v_new) > 0 or jsonb_array_length(v_fixed) > 0) and coalesce(array_length(v_to, 1), 0) > 0 then
    insert into email_outbound (purpose, to_addresses, status, attempts, payload)
    values ('health_alert', v_to, 'pending', 0,
            jsonb_build_object('opened', v_new, 'resolved', v_fixed, 'open_total', v_open_total, 'generated_at', now()));
    update health_findings set notified_at = now() where id in (select (x->>'id')::bigint from jsonb_array_elements(v_new) x);
    update health_findings set resolved_notified_at = now() where id in (select (x->>'id')::bigint from jsonb_array_elements(v_fixed) x);
  end if;

  insert into health_runs (duration_ms, checks_run, opened, resolved, open_total, errors)
  values (extract(milliseconds from clock_timestamp() - t0)::int, v_checks, v_opened, v_resolved, v_open_total,
          nullif(v_errors, '[]'::jsonb));
  delete from health_runs where ran_at < now() - interval '30 days';

  return jsonb_build_object('checks', v_checks, 'opened', v_opened, 'resolved', v_resolved,
                            'open_total', v_open_total, 'errors', v_errors,
                            'alerted', jsonb_array_length(v_new) + jsonb_array_length(v_fixed));
end
$fn$;

revoke execute on function public.health_run_checks() from public, anon, authenticated;;
