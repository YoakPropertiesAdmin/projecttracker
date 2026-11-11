import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import CryptoJS from "npm:crypto-js@4.2.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { db, DEFAULT_LOCATION, logSync } from "../_shared/crm-client.ts";

/**
 * GHL Custom Page single sign-on for TradeDesk (named without "ghl": portal URL rule).
 *
 * The /embed page asks GHL's parent window for REQUEST_USER_DATA and posts the
 * encrypted blob here. We decrypt it with the app's Shared Secret exactly as
 * GHL's template does (CryptoJS AES, passphrase mode), then:
 *   - require the active location to be the Renew sub-account
 *   - find an EXISTING TradeDesk login: linked ghl_user_id first, then email,
 *     and only logins that hold a TradeDesk role (user_roles)
 *   - never create a user; unknown GHL users get 403 "ask an admin"
 *   - mint a Supabase session for that login (admin magic-link token, verified
 *     server-side) and return only the session tokens.
 * The shared secret and the service key never leave this function.
 */

const SHARED_SECRET = (Deno.env.get("GHL_SHARED_SECRET") || "").trim();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://www.renewhomeext.com,https://renewhomeext.com,https://renewprojecttracker.netlify.app,http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Vary": "Origin",
  };
}

Deno.serve(async (req: Request) => {
  const h = cors(req);
  const json = (s: number, b: unknown) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...h, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.includes(origin)) return json(403, { error: "origin not allowed" });
  if (!SHARED_SECRET) return json(500, { error: "SSO is not configured" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "body must be JSON" }); }
  const enc = typeof body?.encryptedData === "string" ? body.encryptedData : "";
  if (!enc) return json(400, { error: "missing encryptedData" });

  let user: any;
  try {
    const plain = CryptoJS.AES.decrypt(enc, SHARED_SECRET).toString(CryptoJS.enc.Utf8);
    user = JSON.parse(plain);
  } catch {
    return json(401, { error: "could not verify the GoHighLevel user" });
  }
  if (!user?.userId) return json(401, { error: "could not verify the GoHighLevel user" });

  const loc = user.activeLocation || null;
  if (DEFAULT_LOCATION && loc !== DEFAULT_LOCATION) {
    await logSync({ direction: "in", entity: "sso", action: "wrong_location", ok: false, ghl_id: user.userId,
                    source: "td-sso", detail: { activeLocation: loc, type: user.type ?? null } });
    return json(403, { error: "TradeDesk is only available inside the Renew Home Exteriors sub-account." });
  }

  const { data: found, error: fErr } = await db().rpc("ghl_sso_find_login",
    { p_ghl_user_id: user.userId, p_email: user.email ?? "" });
  if (fErr) return json(500, { error: "lookup failed" });
  const login = found?.[0];
  if (!login) {
    await logSync({ direction: "in", entity: "sso", action: "denied_no_login", ok: false, ghl_id: user.userId,
                    source: "td-sso", detail: { email: user.email ?? null, name: user.userName ?? null, role: user.role ?? null } });
    return json(403, { error: "No TradeDesk login matches your GoHighLevel account. Ask an admin to invite " +
                              (user.email || "your email") + " to TradeDesk." });
  }

  // Link on first visit (by email) so a later email change in GHL still matches.
  await db().from("ghl_user_links").upsert({
    user_id: login.user_id, ghl_user_id: user.userId, ghl_email: user.email ?? null,
    last_sso_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  // Mint a session: admin magic-link token, verified here, never emailed.
  const { data: link, error: lErr } = await db().auth.admin.generateLink({ type: "magiclink", email: login.email });
  const tokenHash = link?.properties?.hashed_token;
  if (lErr || !tokenHash) return json(500, { error: "could not start a session" });

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: v, error: vErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (vErr || !v?.session) return json(500, { error: "could not start a session" });

  await logSync({ direction: "in", entity: "sso", action: "signed_in", ok: true, ghl_id: user.userId,
                  source: "td-sso", detail: { matched_by: login.matched_by, role: login.role } });

  return json(200, {
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
    expires_in: v.session.expires_in,
    email: login.email,
  });
});
