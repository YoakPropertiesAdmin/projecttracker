-- Async HTTP from Postgres. Needed for the reconciliation sweep (cron calling
-- an edge function) and, right now, the only route available for calling our
-- own function to test it.
create extension if not exists pg_net with schema extensions;;
