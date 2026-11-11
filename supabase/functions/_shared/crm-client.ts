/**
 * Shared GoHighLevel client for the TradeDesk marketplace app.
 *
 * Tokens live in Vault and are reached only through service-role RPCs
 * (ghl_get_tokens / ghl_save_tokens / ghl_claim_refresh / ghl_mark_uninstalled).
 *
 * Refresh rules that matter:
 *  - GHL ROTATES refresh tokens: using one invalidates it. Two refreshes racing
 *    would leave one of them holding a dead token, so refresh takes a short
 *    lease (ghl_claim_refresh). A caller that loses the race waits for the
 *    winner's new token instead of refreshing again.
 *  - invalid_grant / 401 on refresh means the app was uninstalled or the grant
 *    revoked. That marks the location uninstalled — this is the uninstall
 *    signal, because the portal does not offer the AppUninstall event.
 */
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const GHL_BASE = (Deno.env.get("GHL_API_BASE") || "https://services.leadconnectorhq.com").replace(/\/$/, "");
export const GHL_VERSION = Deno.env.get("GHL_API_VERSION") || "2021-07-28";
export const DEFAULT_LOCATION = (Deno.env.get("GHL_LOCATION_ID") || "").trim();

const CLIENT_ID = (Deno.env.get("GHL_CLIENT_ID") || "").trim();
const CLIENT_SECRET = (Deno.env.get("GHL_CLIENT_SECRET") || "").trim();

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let _db: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_db) {
    _db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _db;
}

export class CrmAuthError extends Error {
  constructor(msg: string, public readonly uninstalled = false) { super(msg); }
}

type TokenRow = {
  access_token: string | null; refresh_token: string | null;
  expires_at: string | null; company_id: string | null; uninstalled_at: string | null;
};

async function readTokens(locationId: string): Promise<TokenRow | null> {
  const { data, error } = await db().rpc("ghl_get_tokens", { p_location_id: locationId });
  if (error) throw new Error("ghl_get_tokens: " + error.message);
  return (data && data[0]) || null;
}

export type TokenResponse = {
  access_token: string; refresh_token: string; expires_in: number;
  scope?: string; userType?: string; locationId?: string; companyId?: string; userId?: string;
};

/** POST form-encoded to /oauth/token. Used for both code exchange and refresh. */
export async function tokenRequest(params: Record<string, string>) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("GHL_CLIENT_ID / GHL_CLIENT_SECRET not set");
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params });
  const res = await fetch(GHL_BASE + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, body: json };
}

export async function saveTokens(t: TokenResponse, fallbackLocation?: string) {
  const loc = t.locationId || fallbackLocation;
  if (!loc) throw new Error("token response has no locationId");
  const { error } = await db().rpc("ghl_save_tokens", {
    p_location_id: loc,
    p_company_id: t.companyId ?? null,
    p_user_type: t.userType ?? null,
    p_access_token: t.access_token,
    p_refresh_token: t.refresh_token,
    p_expires_in: Math.max(60, Math.floor(Number(t.expires_in) || 0)),
    p_scopes: t.scope ?? null,
  });
  if (error) throw new Error("ghl_save_tokens: " + error.message);
  return loc;
}

export async function logSync(row: {
  direction: "in" | "out"; entity: "contact" | "opportunity" | "install" | "sso";
  action: string; ok: boolean; ghl_id?: string | null; job_id?: string | null;
  source?: string; detail?: unknown;
}) {
  await db().from("ghl_sync_log").insert(row).then(() => {}, () => {});
}

async function refresh(locationId: string, row: TokenRow): Promise<string> {
  const claimed = await db().rpc("ghl_claim_refresh", { p_location_id: locationId, p_lease_seconds: 30 });
  if (claimed.error) throw new Error("ghl_claim_refresh: " + claimed.error.message);

  if (!claimed.data) {
    // Someone else is refreshing. Wait for their token rather than burning ours.
    const before = row.expires_at;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const now = await readTokens(locationId);
      if (now?.access_token && now.expires_at !== before) return now.access_token;
    }
    throw new CrmAuthError("timed out waiting for a concurrent token refresh");
  }

  const r = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token || "",
    user_type: locationId.startsWith("company:") ? "Company" : "Location",
  });

  if (!r.ok) {
    const code = String(r.body?.error || "");
    const dead = r.status === 401 || code === "invalid_grant" || code === "unauthorized_client";
    if (dead) {
      await db().rpc("ghl_mark_uninstalled", { p_location_id: locationId });
      await logSync({ direction: "in", entity: "install", action: "refresh_rejected_marked_uninstalled",
                      ok: false, ghl_id: locationId, source: "crm-client", detail: { status: r.status, body: r.body } });
      throw new CrmAuthError("refresh rejected (" + r.status + " " + code + "); location marked uninstalled", true);
    }
    // Lease expires on its own after 30s, so a transient failure can be retried.
    throw new CrmAuthError("refresh failed: HTTP " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
  }

  await saveTokens(r.body as TokenResponse, locationId);
  await logSync({ direction: "in", entity: "install", action: "token_refreshed", ok: true,
                  ghl_id: locationId, source: "crm-client", detail: { expires_in: r.body?.expires_in } });
  return r.body.access_token;
}

/** A valid access token for the location, refreshing if it expires within 5 minutes. */
export async function getToken(locationId = DEFAULT_LOCATION, opts: { force?: boolean } = {}): Promise<string> {
  if (!locationId) throw new Error("no locationId and GHL_LOCATION_ID not set");
  const row = await readTokens(locationId);
  if (!row || !row.refresh_token) throw new CrmAuthError("app is not installed on location " + locationId);
  if (row.uninstalled_at) throw new CrmAuthError("app was uninstalled from location " + locationId, true);

  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (!opts.force && row.access_token && exp - Date.now() > REFRESH_MARGIN_MS) return row.access_token;
  return refresh(locationId, row);
}

/**
 * Mint a fresh Location token from the stored agency (Company) token and save
 * it. Used when GHL reinstalls the app on the sub-account without an OAuth
 * redirect (INSTALL webhook), and for manual reconnects. Clears uninstalled_at.
 */
export async function exchangeLocationToken(companyId: string, locationId = DEFAULT_LOCATION) {
  const agency = await getToken("company:" + companyId);
  const waits = [0, 1500, 3000];
  let status = 0; let body: any = {};
  for (const w of waits) {
    if (w) await sleep(w);
    const res = await fetch(GHL_BASE + "/oauth/locationToken", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + agency, Version: GHL_VERSION,
        "content-type": "application/x-www-form-urlencoded", Accept: "application/json",
      },
      body: new URLSearchParams({ companyId, locationId }),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
    if (res.ok && body?.access_token) break;
    if (status !== 400) break;
  }
  if (!body?.access_token) {
    await logSync({ direction: "in", entity: "install", action: "location_token_failed", ok: false,
                    ghl_id: locationId, source: "crm-client", detail: { status, body } });
    throw new CrmAuthError("locationToken exchange failed: HTTP " + status);
  }
  await saveTokens({ ...body, companyId: body.companyId || companyId }, locationId);
  await logSync({ direction: "in", entity: "install", action: "location_token_from_agency", ok: true,
                  ghl_id: locationId, source: "crm-client" });
  return locationId;
}

/**
 * Authenticated GHL call. Retries 429 (≈100 req / 10 s per location) with
 * backoff honouring Retry-After, and on 401 refreshes once and retries.
 */
export async function ghlFetch(path: string, init: RequestInit = {}, locationId = DEFAULT_LOCATION) {
  let token = await getToken(locationId);
  let refreshed = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(GHL_BASE + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + token, Version: GHL_VERSION,
        Accept: "application/json", "content-type": "application/json",
        ...(init.headers || {}),
      },
    });

    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getToken(locationId, { force: true });
      continue;
    }

    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: res.status, ok: res.ok, body };
  }
  return { status: 429, ok: false, body: { error: "rate limited after retries" } };
}

// ---- thin helpers (only what TradeDesk uses) ------------------------------
export const crm = {
  location: (id = DEFAULT_LOCATION) => ghlFetch("/locations/" + id, {}, id),
  pipelines: (loc = DEFAULT_LOCATION) => ghlFetch("/opportunities/pipelines?locationId=" + loc, {}, loc),
  opportunity: (id: string, loc = DEFAULT_LOCATION) => ghlFetch("/opportunities/" + id, {}, loc),
  updateOpportunity: (id: string, patch: Record<string, unknown>, loc = DEFAULT_LOCATION) =>
    ghlFetch("/opportunities/" + id, { method: "PUT", body: JSON.stringify(patch) }, loc),
  searchOpportunities: (qs: string, loc = DEFAULT_LOCATION) =>
    ghlFetch("/opportunities/search?location_id=" + loc + (qs ? "&" + qs : ""), {}, loc),
  contact: (id: string, loc = DEFAULT_LOCATION) => ghlFetch("/contacts/" + id, {}, loc),
};
