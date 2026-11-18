alter table public.jobs add column if not exists paid_status text
  check (paid_status in ('in_progress','completed'));
comment on column public.jobs.paid_status is
  'Set by hand once a job is paid in full: in_progress = paid but work continues (tag only); completed = paid and done (green card, sinks to bottom). Null = not chosen. Only honoured while the balance is <= 0.';

create or replace function public.guard_job_columns()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$ begin if auth.uid() is null or public.is_admin() then return new; end if; if (new.customer_name, new.customer_phone, new.customer_email, new.customer_address, new.trade, new.trades, new.is_repair, new.stage, new.substage, new.flag, new.contract_amount, new.start_date, new.target_date, new.ghl_opportunity_id, new.ghl_project_display_id, new.ghl_status, new.ghl_contact_id, new.contract_signed_date, new.materials_ordered_date, new.number, new.group_id, new.trade_locked, new.status_locked, new.paid_status) is distinct from (old.customer_name, old.customer_phone, old.customer_email, old.customer_address, old.trade, old.trades, old.is_repair, old.stage, old.substage, old.flag, old.contract_amount, old.start_date, old.target_date, old.ghl_opportunity_id, old.ghl_project_display_id, old.ghl_status, old.ghl_contact_id, old.contract_signed_date, old.materials_ordered_date, old.number, old.group_id, old.trade_locked, old.status_locked, old.paid_status) then raise exception 'your account can only change the notes on a job' using errcode = '42501'; end if; return new; end; $function$;

-- Backfill: jobs paid in full today keep their look if they are done,
-- otherwise start as paid / in progress.
with p as (select job_id, sum(amount) amt from public.client_payments group by job_id)
update public.jobs j
   set paid_status = case when j.stage in ('completed','closed') then 'completed' else 'in_progress' end
  from p
 where p.job_id = j.id and j.contract_amount > 0 and j.contract_amount - p.amt <= 0
   and j.paid_status is null;;
