alter table public.payment_types add column if not exists is_credit boolean not null default false;
comment on column public.payment_types.is_credit is 'Money off the signed contract applied after signing (not cash). Reduces net contract, balance and GP; never counts as collected.';
insert into public.payment_types (key, label, sort_order, active, is_credit) values ('customer_credit', 'Customer credit', 50, true, true) on conflict (key) do update set is_credit = true, label = excluded.label;;
