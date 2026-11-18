-- The old loop guard compared new.substage against the target stage name and
-- skipped when they matched. substage is only ever as fresh as the last inbound
-- delivery, so the moment a card is moved in GHL without a webhook firing, the
-- two disagree and EVERY later write-back for that job is silently dropped.
-- That is what made the write-back look account-dependent: it was state-
-- dependent, and the state had gone stale.
--
-- The authoritative check already lives in the ghl-outbound function, which
-- reads the opportunity before every write and skips when it is already in the
-- target stage. That cannot go stale, because it asks GHL.
--
-- Loop safety without the substage guard:
--   inbound sets stage=closed -> trigger enqueues -> function reads GHL, finds
--   the card already in Project Complete -> marks the row 'skipped', writes
--   nothing. No cycle, just one cheap no-op row.
--   The function's own substage patch does not touch `stage`, and the trigger is
--   declared AFTER UPDATE OF stage, so it cannot re-fire itself.

create or replace function public.queue_ghl_writeback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare t record;
begin
  if new.stage is not distinct from old.stage then return new; end if;
  if new.ghl_opportunity_id is null then return new; end if;

  select * into t from public.ghl_writeback_targets
   where td_stage = new.stage and active;
  if not found then return new; end if;

  insert into public.ghl_outbound (job_id, opportunity_id, target_stage_name, set_status, reason)
  values (new.id, new.ghl_opportunity_id, t.ghl_stage_name, t.set_status,
          'TradeDesk stage ' || coalesce(old.stage, '(none)') || ' -> ' || new.stage)
  on conflict (job_id, target_stage_name) where status = 'pending'
  do update set opportunity_id = excluded.opportunity_id,
                set_status     = excluded.set_status,
                reason         = excluded.reason,
                created_at     = now();

  perform public.kick_ghl_outbound();
  return new;
end;
$$;

revoke execute on function public.queue_ghl_writeback() from public, anon, authenticated;;
