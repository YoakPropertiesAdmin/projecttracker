create table if not exists public.ghl_type_fix (opportunity_id text primary key, job_id uuid references public.jobs(id) on delete cascade, job_number bigint, customer text, new_value text not null, ghl_value_before text, ghl_value_after text, status text not null default 'pending', error text, checked_at timestamptz, written_at timestamptz);
alter table public.ghl_type_fix enable row level security;
create policy ghl_type_fix_admin_read on public.ghl_type_fix for select using (public.is_admin());
insert into public.ghl_type_fix(opportunity_id, job_id, job_number, customer, new_value)
select distinct on (p.ghl_opportunity_id) p.ghl_opportunity_id, p.id, p.number, p.customer_name,
 (select string_agg(t.label, ' / ' order by t.sort_order) from public.trades t where t.key = any(p.new_trades)) || case when p.new_repair then ' Repair' else '' end
from public.trade_fix_plan p where p.ghl_opportunity_id is not null order by p.ghl_opportunity_id, p.number
on conflict (opportunity_id) do nothing;;
