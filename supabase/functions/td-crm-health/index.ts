import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { crm, db, DEFAULT_LOCATION, exchangeLocationToken, getToken } from "../_shared/crm-client.ts";

/**
 * Admin check for the marketplace-app connection. Same credential as
 * ghl-sync / ghl-outbound (webhook_credentials.id = 'ghl_admin').
 *
 *   GET                  token expiry + a live GET /locations/{id}
 *   GET ?force_refresh=1 refresh first (proves rotation + save work)
 *
 * Never returns a token.
 */

const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "content-type": "application/json" } });

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return json(401, { error: "missing token" });
  const { data: cred } = await db().from("webhook_credentials").select("secret_hash").eq("id", "ghl_admin").maybeSingle();
  if (!cred?.secret_hash || !safeEq(await sha256Hex(token), cred.secret_hash)) return json(401, { error: "bad token" });

  const loc = url.searchParams.get("location") || DEFAULT_LOCATION;
  const force = url.searchParams.get("force_refresh") === "1";

  const before = await db().from("ghl_installations")
    .select("location_id,company_id,user_type,expires_at,scopes,installed_at,uninstalled_at,last_refreshed_at")
    .eq("location_id", loc).maybeSingle();
  if (!before.data) return json(200, { installed: false, location: loc });

  try {
    if (url.searchParams.get("reconnect") === "1") {
      const companyId = before.data.company_id;
      if (!companyId) return json(200, { error: "no company_id on the install row" });
      await exchangeLocationToken(companyId, loc);
    }
    const oppId = url.searchParams.get("opportunity");
    if (oppId) {
      const r = await crm.opportunity(oppId, loc);
      const o = r.body?.opportunity;
      return json(200, { status: r.status, name: o?.name ?? null, monetaryValue: o?.monetaryValue ?? null,
        customFields: (o?.customFields || []).map((f: any) => ({ id: f.id, value: f.fieldValue ?? f.value ?? null })) });
    }
    if (force) await getToken(loc, { force: true });
    const live = await crm.location(loc);
    const after = await db().from("ghl_installations").select("expires_at,last_refreshed_at")
      .eq("location_id", loc).maybeSingle();
    return json(200, {
      installed: true, location: loc, forced_refresh: force,
      before: before.data, after: after.data,
      api_check: { status: live.status, ok: live.ok, name: live.body?.location?.name ?? null },
    });
  } catch (e) {
    return json(200, { installed: true, location: loc, error: String(e), before: before.data });
  }
});
