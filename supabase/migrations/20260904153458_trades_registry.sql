-- Project types as data, not a constant in App.jsx. Adding gutters or decking
-- becomes one row instead of a code change, a push and a Netlify build — and
-- the board filter, the new-job form and the reports all pick it up on the
-- next load.
create table if not exists public.trades (
  key        text primary key,                       -- stored on jobs.trade
  label      text not null,
  color      text not null default '#8A8478',
  icon       text not null default 'tag',            -- lucide name, resolved in the app
  sort_order integer not null default 100,
  active     boolean not null default true,          -- retire a type without breaking old jobs
  created_at timestamptz not null default now()
);

-- What GoHighLevel might call the same thing. Lowercased on both sides, so
-- 'Roofing', 'roof', 're-roof' all land on 'roofing' without touching code.
create table if not exists public.trade_aliases (
  alias     text primary key,
  trade_key text not null references public.trades(key) on delete cascade
);

alter table public.trades enable row level security;
alter table public.trade_aliases enable row level security;
revoke all on public.trades, public.trade_aliases from anon;

do $$
declare t text;
begin
  foreach t in array array['trades','trade_aliases'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_write', t);
  end loop;
end $$;

insert into public.trades (key, label, color, icon, sort_order) values
  ('roofing','Roofing','#C1440E','home',      10),
  ('siding', 'Siding', '#5B7B9A','layers',    20),
  ('windows','Windows','#3F8EA6','appwindow', 30),
  ('doors',  'Doors',  '#8A6D3B','dooropen',  40)
on conflict (key) do update
  set label = excluded.label, color = excluded.color,
      icon = excluded.icon, sort_order = excluded.sort_order;

insert into public.trade_aliases (alias, trade_key) values
  ('roofing','roofing'), ('roof','roofing'), ('re-roof','roofing'), ('reroof','roofing'),
  ('siding','siding'), ('side','siding'),
  ('windows','windows'), ('window','windows'),
  ('doors','doors'), ('door','doors')
on conflict (alias) do update set trade_key = excluded.trade_key;

-- Resolve a GHL project type to a trade key. Returns null when nothing matches,
-- which the mapper treats as "accept it and flag" rather than a failure — a
-- signed contract is never rejected over a dropdown label.
create or replace function public.resolve_trade(p_raw text)
returns text language sql stable set search_path = '' as $$
  select coalesce(
    (select a.trade_key from public.trade_aliases a where a.alias = lower(btrim(p_raw))),
    (select t.key from public.trades t where t.key = lower(btrim(p_raw))),
    (select t.key from public.trades t where lower(t.label) = lower(btrim(p_raw)))
  );
$$;;
