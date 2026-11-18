create or replace view public.job_financials with (security_invoker = true) as
select j.id as job_id, j.number, j.customer_name, j.trade, j.trades, j.is_repair, j.stage, j.substage, j.flag,
  coalesce(j.flag = 'on_hold', false) as on_hold, j.ghl_status, j.contract_amount,
  coalesce(cp.received, 0::numeric) as client_received,
  j.contract_amount - coalesce(cp.received, 0::numeric) - coalesce(cc.credits, 0::numeric) as balance_due,
  j.contract_amount > 0::numeric and coalesce(cp.received, 0::numeric) + coalesce(cc.credits, 0::numeric) >= j.contract_amount as paid_in_full,
  coalesce(vp.paid, 0::numeric) as vendor_paid, coalesce(vp.pending, 0::numeric) as vendor_pending,
  coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric) as vendor_total,
  (j.contract_amount - coalesce(cc.credits, 0::numeric)) - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric)) as margin,
  case when (j.contract_amount - coalesce(cc.credits, 0::numeric)) > 0::numeric
    then round(((j.contract_amount - coalesce(cc.credits, 0::numeric)) - (coalesce(vp.paid, 0::numeric) + coalesce(vp.pending, 0::numeric))) / (j.contract_amount - coalesce(cc.credits, 0::numeric)), 4)
    else 0::numeric end as margin_pct,
  j.start_date, j.target_date, j.ghl_project_display_id,
  coalesce(cc.credits, 0::numeric) as client_credits,
  j.contract_amount - coalesce(cc.credits, 0::numeric) as net_contract
from jobs j
left join lateral (select sum(c.amount) as received from client_payments c where c.job_id = j.id) cp on true
left join lateral (select sum(k.amount) as credits from client_credits k where k.job_id = j.id) cc on true
left join lateral (select sum(v.amount) filter (where v.status = 'paid') as paid,
                          sum(v.amount) filter (where v.status = 'pending') as pending
                   from vendor_payments v where v.job_id = j.id) vp on true;
comment on column public.job_financials.net_contract is 'Net revenue: contract minus client credits. Reports use this for revenue and GP %; the contract itself is never changed.';
do $d$ declare s text; n text; begin s := pg_get_functiondef('public.finalize_job_gp(uuid)'::regprocedure); n := replace(s, 'values (p_job, v_seq, f.contract_amount, f.client_received', 'values (p_job, v_seq, f.net_contract, f.client_received'); n := replace(n, 'if coalesce(f.contract_amount, 0) <= 0 then', 'if coalesce(f.net_contract, 0) <= 0 then'); if n = s then raise exception 'finalize: no match'; end if; execute n; s := pg_get_functiondef('public.report_monthly_scorecard'::regproc); n := replace(s, 'jf.contract_amount rev,', 'jf.net_contract rev,'); if n = s then raise exception 'scorecard prov: no match'; end if; s := n; n := replace(s, '(select coalesce(sum(l.contract_amount), 0) from comp c join live l on l.id = c.job_id where', '(select coalesce(sum(jf2.net_contract), 0) from comp c join live l on l.id = c.job_id join public.job_financials jf2 on jf2.job_id = l.id where'); if n = s then raise exception 'scorecard completed: no match'; end if; execute n; end $d$;;
