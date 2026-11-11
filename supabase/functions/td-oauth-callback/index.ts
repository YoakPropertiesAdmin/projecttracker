import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  GHL_BASE, GHL_VERSION, DEFAULT_LOCATION, logSync, saveTokens, tokenRequest, TokenResponse,
} from "../_shared/crm-client.ts";

/**
 * OAuth redirect target for the TradeDesk marketplace app.
 *
 * Named without "ghl" because the GHL portal refuses redirect URLs that
 * reference HighLevel.
 *
 * GHL redirects here with ?code=… after the user approves the install. The
 * code is single-use and short-lived, so it is exchanged immediately. This is
 * also the install record: the portal does not offer an AppInstall webhook.
 *
 * If the install was done at agency level (Company token), the company token
 * is exchanged for a Location token for GHL_LOCATION_ID, since everything in
 * TradeDesk is per-location.
 *
 * Responds with a 302 to the app rather than HTML, because Supabase serves
 * HTML from functions on *.supabase.co as text/plain.
 */

const APP_URL = (Deno.env.get("APP_URL") || "https://www.renewhomeext.com").replace(/\/$/, "");
const REDIRECT_URI = Deno.env.get("GHL_REDIRECT_URI") ||
  `${Deno.env.get("SUPABASE_URL")}/functions/v1/td-oauth-callback`;

const done = (ok: boolean, msg: string) =>
  Response.redirect(`${APP_URL}/?crm_install=${ok ? "ok" : "error"}&msg=${encodeURIComponent(msg)}`, 302);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method !== "GET") return new Response("GET only", { status: 405 });

  const err = url.searchParams.get("error");
  if (err) {
    await logSync({ direction: "in", entity: "install", action: "oauth_denied", ok: false,
                    source: "oauth-callback", detail: { error: err, desc: url.searchParams.get("error_description") } });
    return done(false, "Install was not approved: " + err);
  }

  const code = url.searchParams.get("code");
  if (!code) return new Response("missing code", { status: 400 });

  const ex = await tokenRequest({
    grant_type: "authorization_code", code, user_type: "Location", redirect_uri: REDIRECT_URI,
  });
  if (!ex.ok) {
    await logSync({ direction: "in", entity: "install", action: "code_exchange_failed", ok: false,
                    source: "oauth-callback", detail: { status: ex.status, body: ex.body } });
    return done(false, "Token exchange failed (HTTP " + ex.status + ")");
  }

  let tok = ex.body as TokenResponse;

  // Agency-level install: trade the company token for this location's token.
  if ((tok.userType || "").toLowerCase() === "company" && !tok.locationId) {
    if (!DEFAULT_LOCATION || !tok.companyId) return done(false, "Agency token received but no location to use");
    // Keep the agency token (keyed company:<id>) so a later sub-account install
    // can be exchanged without another approval, and log what GHL said it covers.
    const meta = tok as unknown as Record<string, unknown>;
    await saveTokens(tok, "company:" + tok.companyId).catch(() => {});
    await logSync({ direction: "in", entity: "install", action: "agency_token_received", ok: true,
                    ghl_id: tok.companyId, source: "oauth-callback",
                    detail: { isBulkInstallation: meta.isBulkInstallation ?? null,
                              approvedLocations: meta.approvedLocations ?? null,
                              scopes: tok.scope, userId: tok.userId } });
    // An agency user installing on a sub-account always gets a Company token,
    // and the sub-account install can finish a few seconds AFTER the redirect.
    // So "no access to this location" is retried before it is believed.
    const waits = [0, 1500, 2500, 4000, 6000];
    let lt: Response | null = null;
    let ltBody: any = {};
    let tries = 0;
    for (const w of waits) {
      if (w) await new Promise((r) => setTimeout(r, w));
      tries++;
      lt = await fetch(GHL_BASE + "/oauth/locationToken", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tok.access_token, Version: GHL_VERSION,
          "content-type": "application/x-www-form-urlencoded", Accept: "application/json",
        },
        body: new URLSearchParams({ companyId: tok.companyId, locationId: DEFAULT_LOCATION }),
      });
      ltBody = await lt.json().catch(() => ({}));
      if (lt.ok && ltBody?.access_token) break;
      if (lt.status !== 400) break;
    }
    if (!lt || !lt.ok || !ltBody?.access_token) {
      await logSync({ direction: "in", entity: "install", action: "location_token_failed", ok: false,
                      source: "oauth-callback", detail: { status: lt?.status, tries, body: ltBody } });
      return done(false, lt?.status === 400
        ? "GHL issued an agency token but would not exchange it for the Renew sub-account after " + tries + " tries."
        : "Could not get a sub-account token (HTTP " + lt?.status + ")");
    }
    tok = { ...ltBody, companyId: ltBody.companyId || tok.companyId };
  }

  try {
    const loc = await saveTokens(tok);
    const expected = !DEFAULT_LOCATION || loc === DEFAULT_LOCATION;
    await logSync({ direction: "in", entity: "install", action: "installed", ok: true, ghl_id: loc,
                    source: "oauth-callback",
                    detail: { companyId: tok.companyId, userType: tok.userType, scopes: tok.scope,
                              userId: tok.userId, expected_location: expected } });
    return done(true, expected ? "TradeDesk connected" : "Connected to an unexpected location " + loc);
  } catch (e) {
    await logSync({ direction: "in", entity: "install", action: "save_failed", ok: false,
                    source: "oauth-callback", detail: { error: String(e) } });
    return done(false, "Tokens received but could not be saved");
  }
});
