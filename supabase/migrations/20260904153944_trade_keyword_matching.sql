-- Exact aliases only ever caught values someone had already thought of.
-- Replaced with keyword matching: a project type is scanned for keywords, and
-- what it contains decides the trade — 'Roof Replacement', 'Full Re-Roof' and
-- 'roofing' all land on roofing without anyone maintaining a synonym list.

create table if not exists public.trade_keywords (
  keyword    text primary key,   -- lowercase; matched as a substring
  trade_key  text references public.trades(key) on delete cascade,
  work_type  text,               -- 'repair' — orthogonal to the trade
  constraint trade_keywords_target check (trade_key is not null or work_type is not null)
);

alter table public.trade_keywords enable row level security;
revoke all on public.trade_keywords from anon;
drop policy if exists trade_keywords_read on public.trade_keywords;
create policy trade_keywords_read on public.trade_keywords for select to authenticated using (true);
drop policy if exists trade_keywords_write on public.trade_keywords;
create policy trade_keywords_write on public.trade_keywords for all to authenticated using (true) with check (true);

-- 'combo' is a real trade key so the board, filters and reports treat it like
-- any other; the component trades are kept on the job in jobs.trades.
insert into public.trades (key,label,color,icon,sort_order) values
  ('combo','Combo','#7A6A93','layers',90)
on conflict (key) do update set label = excluded.label, color = excluded.color;

insert into public.trade_keywords (keyword, trade_key) values
  ('roof','roofing'), ('shingle','roofing'), ('gutter','roofing'),
  ('siding','siding'), ('sided','siding'), ('wrap','siding'),
  ('window','windows'), ('glass','windows'),
  ('door','doors'), ('entry','doors')
on conflict (keyword) do update set trade_key = excluded.trade_key;

insert into public.trade_keywords (keyword, work_type) values
  ('repair','repair'), ('patch','repair'), ('fix','repair'), ('service call','repair')
on conflict (keyword) do update set work_type = excluded.work_type;

-- Trades a project type mentions, in registry order. Empty array = no idea.
create or replace function public.match_trades(p_raw text)
returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(distinct k.trade_key order by k.trade_key), '{}')
  from public.trade_keywords k
  join public.trades t on t.key = k.trade_key
  where k.trade_key is not null
    and p_raw is not null
    and lower(btrim(p_raw)) like '%' || k.keyword || '%';
$$;

create or replace function public.match_is_repair(p_raw text)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.trade_keywords k
    where k.work_type = 'repair'
      and p_raw is not null
      and lower(btrim(p_raw)) like '%' || k.keyword || '%'
  );
$$;

-- Kept for direct hits that keywords would miss entirely.
create or replace function public.resolve_trade(p_raw text)
returns text language sql stable set search_path = '' as $$
  select coalesce(
    (select t.key from public.trades t where t.key = lower(btrim(p_raw))),
    (select t.key from public.trades t where lower(t.label) = lower(btrim(p_raw))),
    (select case when cardinality(m) = 1 then m[1]
                 when cardinality(m) > 1 then 'combo' end
       from public.match_trades(p_raw) m)
  );
$$;

alter table public.jobs
  -- Component trades when more than one matched. Single-trade jobs get a
  -- one-element array, so reporting can always read this rather than
  -- special-casing combo.
  add column if not exists trades text[] not null default '{}',
  -- Repair is a property of the work, not a trade. Keeping it separate is what
  -- lets a roof repair still count as roofing revenue in the margin reports.
  add column if not exists is_repair boolean not null default false;

create index if not exists idx_jobs_is_repair on public.jobs (is_repair) where is_repair;

update public.jobs set trades = array[trade] where cardinality(trades) = 0 and trade is not null;

drop table if exists public.trade_aliases;;
