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
 *
 * Inside GoHighLevel's iframe (the Renew sidebar page) the session is kept in
 * sessionStorage, falling back to memory, instead of localStorage. Browsers
 * partition or block third-party storage in frames — Safari most of all — and
 * the GHL sign-in (auth/ghlSso.js) re-issues a session on every load anyway.
 * It also keeps the embedded login separate from a normal browser tab.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

function framed() {
  try { return window.self !== window.top; } catch { return true; }
}

/** sessionStorage when the browser allows it in this frame, else memory. */
function frameStorage() {
  const mem = new Map();
  let ss = null;
  try {
    ss = window.sessionStorage;
    const k = "__td_probe__";
    ss.setItem(k, "1");
    ss.removeItem(k);
  } catch {
    ss = null;
  }
  return {
    getItem: (k) => { try { return ss ? ss.getItem(k) : mem.get(k) ?? null; } catch { return mem.get(k) ?? null; } },
    setItem: (k, v) => { mem.set(k, v); try { ss && ss.setItem(k, v); } catch { /* memory copy kept */ } },
    removeItem: (k) => { mem.delete(k); try { ss && ss.removeItem(k); } catch { /* ignore */ } },
  };
}

const embedded = typeof window !== "undefined" && framed();

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        ...(embedded ? { storage: frameStorage(), storageKey: "td-embed-auth" } : {}),
      },
    })
  : null;

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.warn(
    "[TradeDesk] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — " +
      "running against browser localStorage instead of Supabase."
  );
}
