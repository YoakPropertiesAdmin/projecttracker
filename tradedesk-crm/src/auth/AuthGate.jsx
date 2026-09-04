import React, { useState, useEffect } from "react";
import { ClipboardList, LogIn, AlertTriangle, RefreshCw } from "lucide-react";
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
 */
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) { setChecking(false); return; }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!isSupabaseConfigured) return children;

  if (checking) {
    return (
      <div className="td-root td-loading-screen">
        <RefreshCw size={22} className="td-spin" />
        <div>Checking your session…</div>
      </div>
    );
  }

  if (!session) return <SignIn />;

  return children;
}

function SignIn() {
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
    if (err) setError(err.message || "Sign-in failed.");
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
