do $d$ declare s text; old_set text := 'trade = v_trade, trades = v_trades, is_repair = v_repair,'; old_fb text := '(select key from public.trades where active and key <> ''combo'' order by sort_order limit 1)'; lockv text; begin
s := pg_get_functiondef('public.ghl_sync_opportunities(jsonb,uuid)'::regprocedure);
lockv := '(trade_locked or v_type is null or exists (select 1 from public.client_payments cp where cp.job_id = public.jobs.id))';
s := replace(s, old_set, '/* TradeDesk owns the project type once locked, after the first deposit, or when GHL sends none. */ trade = case when ' || lockv || ' then trade else v_trade end, trades = case when ' || lockv || ' then trades else v_trades end, is_repair = case when ' || lockv || ' then is_repair else v_repair end,');
s := replace(s, old_fb, '''other''');
execute s;
s := pg_get_functiondef('public.map_ghl_inbound'::regproc);
lockv := '(trade_locked or v_trade_raw is null or exists (select 1 from public.client_payments cp where cp.job_id = public.jobs.id))';
s := replace(s, old_set, '/* TradeDesk owns the project type once locked, after the first deposit, or when GHL sends none. */ trade = case when ' || lockv || ' then trade else v_trade end, trades = case when ' || lockv || ' then trades else v_trades end, is_repair = case when ' || lockv || ' then is_repair else v_repair end,');
s := replace(s, old_fb, '''other''');
execute s;
end $d$;;
