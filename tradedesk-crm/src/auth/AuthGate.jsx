import React, { useState, useEffect, useCallback, useRef } from "react";
import { ClipboardList, LogIn, AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { supabase, isSupabaseConfigured } from "../data/supabaseClient.js";

/**
 * Sign-in gate.
 *
 * Accounts are invite-only: they are created by an admin in the Supabase
 * dashboard (Authentication -> Users -> Invite), and public sign-up is turned
 * off at the project level. There is deliberately no "create account" path in
 * this UI — every table's RLS policy admits only the `authenticated` role, so
 * an account is the access grant.
 *
 * When the app is running without Supabase env vars (local dev), the gate
 * steps aside entirely and the localStorage fallback is used.
 *
 * ---------------------------------------------------------------------------
 * Recovering from a failed token refresh
 *
 * An access token lasts an hour and is renewed in the background. A phone that
 * has been in someone's pocket wakes up and refreshes immediately, so it is
 * always the device that meets a refresh failure first — which is why an auth
 * restart on 2026-09-11 showed up as raw "invalid JWT" errors on mobile while
 * desktop simply retried and carried on.
 *
 * The distinction that matters is WHY the refresh failed, because the two
 * causes want opposite handling:
 *
 *   token is genuinely dead   -> clear it and ask for a sign-in. Retrying is
 *                                pointless; it will never succeed.
 *   server unreachable        -> keep the session and retry. Signing someone
 *                                out because the network blipped loses their
 *                                place for no reason.
 *
 * Conflating those is what made a brief restart look like a broken app.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The token is finished — no amount of retrying brings it back. */
function isDeadSession(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  const m = (err.message || "").toLowerCase();
  return (
    m.includes("jwt") ||
    m.includes("invalid refresh token") ||
    m.includes("refresh_token_not_found") ||
    m.includes("already used") ||
    m.includes("expired")
  );
}

/** We could not reach the server. The session may well still be good. */
function isUnreachable(err) {
  if (!err) return false;
  if (typeof err.status === "number" && err.status >= 500) return true;
  const m = (err.message || "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed") ||
    m.includes("timeout") ||
    m.includes("aborted")
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState("");
  const [degraded, setDegraded] = useState(false);
  const lastCheck = useRef(0);
  const inFlight = useRef(false);

  /**
   * Confirm with the server that the session is still real. Returns true if
   * it is, false if it is dead and has been cleared, null if we could not tell.
   */
  const revalidate = useCallback(async ({ retries = 3, force = false } = {}) => {
    if (!isSupabaseConfigured || inFlight.current) return null;
    // Waking a phone fires visibility, focus and online together; without this
    // one wake would mean three identical round trips.
    if (!force && Date.now() - lastCheck.current < 30_000) return null;

    inFlight.current = true;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const { data, error } = await supabase.auth.getUser();

        if (!error && data?.user) {
          lastCheck.current = Date.now();
          setDegraded(false);
          return true;
        }

        if (isDeadSession(error)) {
          // Local scope: the server may be the thing that is down, and we still
          // need the stale token out of storage either way.
          try { await supabase.auth.signOut({ scope: "local" }); } catch { /* storage cleared below regardless */ }
          lastCheck.current = Date.now();
          setSession(null);
          setDegraded(false);
          setNotice("Your session expired. Please sign in again.");
          return false;
        }

        // Unreachable, or something we do not recognise: keep the session and
        // back off. Never sign someone out over a network blip.
        setDegraded(true);
        if (attempt < retries) await sleep(800 * 2 ** attempt);
      }
      return null;
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) { setChecking(false); return; }
    let alive = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error && isDeadSession(error)) {
        setSession(null);
        setNotice("Your session expired. Please sign in again.");
      } else {
        setSession(data?.session ?? null);
        // A restored session proves only that a token is in storage, not that
        // it is still honoured. Check before trusting it.
        if (data?.session) revalidate({ force: true });
      }
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      setSession(next);
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        setNotice("");
        setDegraded(false);
        lastCheck.current = Date.now();
      }
      if (event === "SIGNED_OUT" && !next) {
        // supabase-js also emits this when a refresh is rejected, which is the
        // case worth explaining rather than silently showing a login box.
        setNotice((n) => n || "Your session ended. Please sign in again.");
      }
    });

    // A backgrounded tab does not refresh on schedule, so the token can be
    // stale by the time anyone looks at it again. These are the moments a
    // person is about to try to use the app.
    const onWake = () => { if (document.visibilityState === "visible") revalidate(); };
    const onOnline = () => revalidate({ force: true });

    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
    };
  }, [revalidate]);

  if (!isSupabaseConfigured) return children;

  if (checking) {
    return (
      <div className="td-root td-loading-screen">
        <RefreshCw size={22} className="td-spin" />
        <div>Checking your session…</div>
      </div>
    );
  }

  if (!session) return <SignIn notice={notice} />;

  return (
    <>
      {degraded && <ConnectionBanner onRetry={() => revalidate({ force: true })} />}
      {children}
    </>
  );
}

/**
 * Shown instead of signing the person out when the server cannot be reached.
 * Their place in the app is preserved; writes will fail until it clears.
 */
function ConnectionBanner({ onRetry }) {
  return (
    <div className="td-conn-banner" role="status">
      <WifiOff size={14} />
      <span>Can&rsquo;t reach the server — your work is not being saved right now.</span>
      <button type="button" onClick={onRetry}>Retry</button>
      <style>{`
        .td-conn-banner{position:fixed;left:0;right:0;top:0;z-index:9999;display:flex;align-items:center;
          justify-content:center;gap:9px;padding:8px 14px;background:#8A5A12;color:#FDF3E3;
          font-size:12.5px;font-weight:600;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
          padding-top:calc(8px + env(safe-area-inset-top));}
        .td-conn-banner button{margin-left:4px;padding:3px 10px;border:1px solid rgba(253,243,227,.5);
          border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;}
        .td-conn-banner button:hover{background:rgba(253,243,227,.14);}
      `}</style>
    </div>
  );
}

function SignIn({ notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      // "Failed to fetch" tells a person nothing about what to do next.
      setError(
        isUnreachable(err)
          ? "Can't reach the server. Check your connection and try again in a moment."
          : err.message || "Sign-in failed."
      );
    }
    setBusy(false);
  };

  return (
    <div className="td-auth-root">
      <form className="td-auth-card" onSubmit={submit}>
        <div className="td-auth-brand">
          <div className="td-auth-mark"><ClipboardList size={20} strokeWidth={2.4} /></div>
          <div>
            <div className="td-auth-name">TradeDesk</div>
            <div className="td-auth-tag">Job &amp; payment tracker</div>
          </div>
        </div>

        {notice && !error && (
          <div className="td-auth-notice">
            <RefreshCw size={14} /> <span>{notice}</span>
          </div>
        )}

        <label className="td-auth-label" htmlFor="td-email">Work email</label>
        <input id="td-email" className="td-auth-input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label className="td-auth-label" htmlFor="td-password">Password</label>
        <input id="td-password" className="td-auth-input" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} required />

        {error && (
          <div className="td-auth-error">
            <AlertTriangle size={14} /> <span>{error}</span>
          </div>
        )}

        <button className="td-auth-btn" type="submit" disabled={busy || !email || !password}>
          {busy ? <RefreshCw size={15} className="td-spin" /> : <LogIn size={15} />}
          <span>{busy ? "Signing in…" : "Sign in"}</span>
        </button>

        <p className="td-auth-foot">
          Accounts are issued by the office. If you need access, ask IT to invite your work email.
        </p>
      </form>

      <style>{`
        .td-auth-root{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
          background:#F5F2EC;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:#2B2721;}
        .td-auth-card{width:100%;max-width:380px;background:#fff;border:1px solid #E2DCD1;border-radius:14px;
          padding:28px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 30px rgba(43,39,33,.07);}
        .td-auth-brand{display:flex;align-items:center;gap:11px;margin-bottom:18px;}
        .td-auth-mark{width:36px;height:36px;border-radius:9px;background:#2B2721;color:#F5F2EC;
          display:flex;align-items:center;justify-content:center;flex:none;}
        .td-auth-name{font-size:16px;font-weight:650;letter-spacing:-.01em;}
        .td-auth-tag{font-size:12px;color:#8A8478;}
        .td-auth-label{font-size:12px;font-weight:600;color:#6B6459;margin-top:8px;}
        .td-auth-input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #DCD5C9;border-radius:8px;
          font-size:14px;background:#FDFCFA;color:inherit;font-family:inherit;}
        .td-auth-input:focus{outline:none;border-color:#2B2721;box-shadow:0 0 0 3px rgba(43,39,33,.08);}
        .td-auth-notice{display:flex;align-items:center;gap:7px;margin-bottom:6px;padding:9px 11px;border-radius:8px;
          background:#F0EBE1;color:#6B6459;font-size:12.5px;line-height:1.35;}
        .td-auth-error{display:flex;align-items:center;gap:7px;margin-top:12px;padding:9px 11px;border-radius:8px;
          background:#FBEDE9;color:#9B3A20;font-size:12.5px;line-height:1.35;}
        .td-auth-btn{margin-top:18px;display:flex;align-items:center;justify-content:center;gap:8px;
          padding:10px 14px;border:none;border-radius:8px;background:#2B2721;color:#F5F2EC;
          font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;}
        .td-auth-btn:disabled{opacity:.55;cursor:not-allowed;}
        .td-auth-foot{margin:16px 0 0;font-size:11.5px;line-height:1.5;color:#8A8478;text-align:center;}
        .td-spin{animation:td-spin 1s linear infinite;}
        @keyframes td-spin{to{transform:rotate(360deg);}}
      `}</style>
    </div>
  );
}
