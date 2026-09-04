import { createClient } from "@supabase/supabase-js";

/**
 * Supabase connection for TradeDesk.
 *
 * Both values are injected at build time by Vite from the environment:
 *   VITE_SUPABASE_URL       https://<project-ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY  the project's publishable / anon key
 *
 * The anon key is safe to ship in the bundle — it grants nothing on its own.
 * Every table has Row Level Security enabled with policies that only admit
 * the `authenticated` role, so an anonymous visitor holding this key reads
 * zero rows. Access is controlled by who has a login, not by key secrecy.
 *
 * In local dev with no .env present, `supabase` is null and the app falls
 * back to browser localStorage (see repository.js) so `npm run dev` still
 * works without credentials.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.warn(
    "[TradeDesk] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — " +
      "running against browser localStorage instead of Supabase."
  );
}
