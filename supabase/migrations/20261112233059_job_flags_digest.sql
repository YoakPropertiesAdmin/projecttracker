alter table public.email_outbound add column if not exists payload jsonb;

create or replace function public.job_flags_digest(p_to text[] default array['itadmin@yoakproperties.com'])
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_open jsonb; v_n int;
begin
  -- Sheet flags close once their Sales row is linked to a job.
  update job_flags f set resolved_at = now(), resolution = 'Sales row linked to JOB-' || j.number
    from sales_log_rows s join jobs j on j.id = s.job_id
   where f.kind = 'sheet_no_job' and f.resolved_at is null and s.tab = 'Sales' and s.removed_at is null
     and coalesce(s.row_key, 'row:' || s.id) = f.ref;
  -- GHL flags close once the opportunity is on a job.
  update job_flags f set resolved_at = now(), resolution = 'linked to JOB-' || j.number
    from jobs j where f.kind = 'ghl_no_job' and f.resolved_at is null and j.ghl_opportunity_id = f.ref;

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', source, 'kind', kind, 'ref', ref, 'name', name, 'amount', amount,
           'detail', detail, 'candidates', candidates, 'first_seen_at', first_seen_at) order by first_seen_at), '[]'::jsonb),
         count(*)
    into v_open, v_n
    from job_flags where resolved_at is null;

  if v_n = 0 then return jsonb_build_object('open', 0, 'queued', false); end if;
  insert into email_outbound (purpose, to_addresses, status, attempts, payload)
  values ('sync_flags', p_to, 'pending', 0, jsonb_build_object('flags', v_open, 'generated_at', now()));
  return jsonb_build_object('open', v_n, 'queued', true);
end $f$;
revoke all on function public.job_flags_digest(text[]) from public, anon, authenticated;

-- 6:30 AM Eastern (standard time), after the 1:00 AM sweep. Emails only when something is open.
select cron.schedule('job-flags-digest', '30 11 * * *', $$select public.job_flags_digest()$$);;
