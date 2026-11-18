-- GoHighLevel sends dates in two shapes and they need opposite handling:
--
--   "2026-06-23"                  a plain date. Take it as written.
--   "2026-06-23T00:00:00.000Z"    a date PICKER value, stored as midnight UTC.
--                                 Take the UTC date — converting to Eastern
--                                 would drag it back to the 22nd.
--   "2026-06-23T20:13:13.146Z"    a real moment. The business day is the LOCAL
--                                 one, so convert to America/New_York first.
--                                 Without this, anything signed after 8pm
--                                 Eastern would file under the next day.
--
-- Midnight-UTC is the tell that separates a picked date from a timestamp.
create or replace function public.ghl_date(p jsonb, k text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v  text;
  ts timestamptz;
begin
  v := public.ghl_text(p, k);
  if v is null then return null; end if;
  v := btrim(v);

  -- Plain calendar date, no time component.
  if v ~ '^\d{4}-\d{2}-\d{2}$' then
    begin return v::date; exception when others then return null; end;
  end if;

  -- Anything with a time: parse it properly rather than slicing the string.
  if v ~ '^\d{4}-\d{2}-\d{2}[T ]' then
    begin
      ts := v::timestamptz;
    exception when others then
      return null;
    end;
    -- Exactly midnight UTC means a date picker, not an event.
    if (ts at time zone 'UTC')::time = '00:00:00' then
      return (ts at time zone 'UTC')::date;
    end if;
    return (ts at time zone 'America/New_York')::date;
  end if;

  -- Unrecognised. Null beats a guess: a wrong date here turns a card red.
  return null;
end;
$$;;
