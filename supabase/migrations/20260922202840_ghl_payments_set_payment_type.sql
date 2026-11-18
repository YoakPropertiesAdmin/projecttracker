-- A payment arriving from GoHighLevel already knows what it is, so carry that
-- through instead of leaving the reports to guess from sequence. Which CRM
-- field maps to which type is a column on the registry, not a case statement.
alter table public.ghl_payment_fields
  add column if not exists payment_type text references public.payment_types(key);

update public.ghl_payment_fields set payment_type = 'initial_deposit' where source_ref = 'ghl:initial_deposit';
update public.ghl_payment_fields set payment_type = 'second_deposit'  where source_ref = 'ghl:second_deposit';
update public.ghl_payment_fields set payment_type = 'final_payment'   where source_ref = 'ghl:final_payment';

create or replace function public.ghl_apply_payments(p_job_id uuid, p_payload jsonb, p_when timestamptz)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  f       record;
  v_amt   numeric;
  v_sent  boolean;
  applied jsonb := '[]'::jsonb;
  cleared jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  v_gone  int;
begin
  for f in select * from public.ghl_payment_fields where active order by sort_order loop
    v_sent := p_payload ? f.payload_key;
    v_amt  := public.ghl_money(p_payload, f.payload_key);

    if v_amt is not null and v_amt > 0 then
      insert into public.client_payments (job_id, amount, payment_date, method, note, source_ref, payment_type)
      values (p_job_id, v_amt, p_when, f.method,
              'ADDED BY GHL — ' || f.label, f.source_ref, f.payment_type)
      on conflict (job_id, source_ref) where source_ref is not null
      do update set amount = excluded.amount, note = excluded.note,
                    payment_type = coalesce(excluded.payment_type, public.client_payments.payment_type);
      applied := applied || jsonb_build_object('label', f.label, 'amount', v_amt);

    elsif v_sent then
      -- Present and empty: cleared or zeroed in the CRM, so the payment did not
      -- happen. Only ever removes rows this integration created.
      delete from public.client_payments
       where job_id = p_job_id and source_ref = f.source_ref;
      get diagnostics v_gone = row_count;
      if v_gone > 0 then
        cleared := cleared || jsonb_build_object('label', f.label);
      end if;

    else
      -- Field not in this payload at all. The CRM is silent, not empty.
      skipped := skipped || jsonb_build_object('label', f.label);
    end if;
  end loop;

  return jsonb_build_object('applied', applied, 'cleared', cleared, 'not_sent', skipped);
end;
$function$;

revoke execute on function public.ghl_apply_payments(uuid, jsonb, timestamptz) from public, anon, authenticated;;
