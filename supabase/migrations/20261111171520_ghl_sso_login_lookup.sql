-- td-sso: find the TradeDesk login for a GHL user. Linked ghl_user_id first,
-- then email. Only logins that hold a TradeDesk role count; nobody is created.
create or replace function public.ghl_sso_find_login(p_ghl_user_id text, p_email text)
returns table (user_id uuid, email text, role text, matched_by text)
language sql security definer set search_path = ''
as $$
  select u.id, u.email::text, r.role, 'ghl_user_id'
    from public.ghl_user_links l
    join auth.users u on u.id = l.user_id
    join public.user_roles r on r.user_id = u.id
   where l.ghl_user_id = p_ghl_user_id
  union all
  select u.id, u.email::text, r.role, 'email'
    from auth.users u
    join public.user_roles r on r.user_id = u.id
   where lower(u.email) = lower(nullif(btrim(p_email), ''))
     and not exists (select 1 from public.ghl_user_links l where l.ghl_user_id = p_ghl_user_id)
  limit 1;
$$;
revoke all on function public.ghl_sso_find_login(text, text) from public, anon, authenticated;
grant execute on function public.ghl_sso_find_login(text, text) to service_role;;
