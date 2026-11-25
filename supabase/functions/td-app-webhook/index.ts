import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ed25519 } from "npm:@noble/curves@1.4.0/ed25519";
import { crm, db, DEFAULT_LOCATION, exchangeLocationToken, logSync } from "../_shared/crm-client.ts";

/**
 * Signed marketplace-app webhooks (named without "ghl": portal URL rule).
 *
 *  1. Verify X-GHL-Signature (Ed25519, base64) against GHL's public key.
 *     Unsigned or tampered -> 401.
 *  2. Events TradeDesk does not act on (tags, tasks, records, other
 *     pipelines, other locations, notes on contacts that are not on a
 *     monitored-pipeline job) -> 200 at once, no database work.
 *     (v7, 2026-11-25: NoteCreate / NoteUpdate / NoteDelete are mirrored into
 *     contact_notes, but only for contacts on a TradeDesk job with a GHL
 *     opportunity. The contact list is cached for 5 minutes, so the AI call
 *     transcripts and other lead notes never touch the database.)
 *     (v6, 2026-11-24: OpportunityDelete from other pipelines is dropped here
 *     too. A bulk delete of ~7,500 Facebook-lead opportunities sent one
 *     delivery each in two minutes; every one did 3-4 database calls and the
 *     API timed out (522) for everyone, including TradeDesk in the CRM.
 *     TradeDesk jobs only come from the Production pipeline, and the delete
 *     handler only ever logged a line, so nothing is lost.)
 *  3. Everything else -> 200 at once. Storing (dedupe on webhookId, the PK of
 *     ghl_webhook_events) and processing run in EdgeRuntime.waitUntil, with the
 *     store retried, so a slow or briefly failing database never makes GHL wait
 *     or count a failure. (v5, 2026-11-16: GHL paused delivery at 53% success
 *     because answers took ~4.7 s during bursts and cold boots hit
 *     PGRST303 "JWT issued at future".)
 *
 * Opportunity events do NOT trust the payload: the opportunity is re-read from
 * the API and applied with the nightly sweep's own rules
 * (ghl_apply_opportunity_event -> ghl_sync_opportunities).
 */

const PIPELINE = Deno.env.get("GHL_PRODUCTION_PIPELINE_ID") || "ynllopdoIURk6CKPtjNg";

// From marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide (verified 2026-11-10).
const DEFAULT_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;
const PEM = Deno.env.get("GHL_WEBHOOK_PUBLIC_KEY_ED25519") || DEFAULT_PEM;

function rawKeyFromPem(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return der.slice(der.length - 32); // SPKI for Ed25519 = 12-byte header + 32-byte key
}
const PUBKEY = rawKeyFromPem(PEM);

function verify(body: string, sigB64: string): boolean {
  let sig: Uint8Array;
  try { sig = Uint8Array.from(atob(sigB64.trim()), (c) => c.charCodeAt(0)); } catch { return false; }
  if (sig.length !== 64) return false;
  const enc = new TextEncoder();
  try { if (ed25519.verify(sig, enc.encode(body), PUBKEY)) return true; } catch { /* fall through */ }
  try {
    const re = JSON.stringify(JSON.parse(body));
    if (re !== body) return ed25519.verify(sig, enc.encode(re), PUBKEY);
  } catch { /* not JSON */ }
  return false;
}

const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- opportunity normalisation: identical field map to ghl-sync ----------
const F = {
  display: "0PyQD5I2itCf0nOdpHSF", street: "1HUElXdGFLyqwVFViCYd", address: "1LjzVxPu7WzexHsSi8bf",
  city: "WPsoqqsi5vlPALc01YDc", state: "zL8uHsMCVCp5j0riG2Qb", zip: "Q0FLnbxGalma3kngxfhV",
  type: "ahJkRoMCrPBqkmwmKsIO", typeOld: "S8XE5l2bsQHtrIk17aEp",
  signed: "tWVSxfJFeGsiORG7YKvI", notes: "oynp2kmyX4EVBCeU39Ob",
  signedDate: "IIJDGI3z2bESbPQfNuDe", materialsDate: "7U5wuHNq6LjUMuseVipP",
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? `${y}-${pad(m)}-${pad(d)}` : null;
};
/** GHL date custom field -> YYYY-MM-DD, or null if unreadable. Never guesses. */
export function parseGhlDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "null") return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return ymd(+m[3], +m[1], +m[2]);
  return null;
}
const txt = (m: Map<string, unknown>, id: string) => {
  const v = m.get(id);
  return v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();
};
const amt = (m: Map<string, unknown>, id: string) => {
  const v = txt(m, id); if (v === null) return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
function normalise(o: any, stageName: Map<string, string>) {
  const cf = new Map<string, unknown>((o.customFields || []).map((f: any) => [f.id, f.fieldValue ?? f.value]));
  const street = txt(cf, F.street) || txt(cf, F.address);
  const city = txt(cf, F.city), st = txt(cf, F.state), zip = txt(cf, F.zip);
  return {
    opportunity_id: o.id, display_id: txt(cf, F.display), contact_id: o.contact?.id || o.contactId || null,
    name: o.name || o.contact?.name || null, status: o.status || "open",
    stage_name: stageName.get(o.pipelineStageId) || null,
    monetary_value: o.monetaryValue ?? null, signed_value: amt(cf, F.signed),
    project_type: txt(cf, F.type) || txt(cf, F.typeOld),
    address: [street, [city, st].filter(Boolean).join(", "), zip].filter(Boolean).join(" ").trim(),
    phone: o.contact?.phone || null, email: o.contact?.email || null,
    notes: txt(cf, F.notes), created_at: o.createdAt || null, updated_at: o.updatedAt || null,
    contract_signed_date: parseGhlDate(cf.get(F.signedDate)),
    materials_ordered_date: parseGhlDate(cf.get(F.materialsDate)),
    _date_warnings: [
      [F.signedDate, "contract signed"], [F.materialsDate, "materials ordered"],
    ].filter(([id]) => txt(cf, id) !== null && parseGhlDate(cf.get(id)) === null)
     .map(([id, label]) => `could not read ${label} date ${JSON.stringify(txt(cf, id))}`),
  };
}

let stageCache: { at: number; map: Map<string, string> } | null = null;
async function stageNames(loc: string) {
  if (stageCache && Date.now() - stageCache.at < 10 * 60 * 1000) return stageCache.map;
  const r = await crm.pipelines(loc);
  const prod = (r.body?.pipelines || []).find((p: any) => p.id === PIPELINE);
  const map = new Map<string, string>((prod?.stages || []).map((s: any) => [s.id, s.name]));
  if (map.size) stageCache = { at: Date.now(), map };
  return map;
}

// ---------- contacts whose notes TradeDesk mirrors ----------
// A contact on a TradeDesk job that came from a monitored pipeline (has a GHL
// opportunity). Cached; a miss re-reads at most once a minute so a brand-new
// job's contact is picked up quickly without a query per note.
let monitoredCache: { at: number; set: Set<string> } | null = null;
async function loadMonitored() {
  const { data, error } = await db().from("jobs").select("ghl_contact_id")
    .not("ghl_contact_id", "is", null).not("ghl_opportunity_id", "is", null);
  if (error) throw new Error("monitored contacts: " + error.message);
  monitoredCache = { at: Date.now(), set: new Set((data || []).map((r: any) => r.ghl_contact_id as string)) };
  return monitoredCache.set;
}
async function isMonitoredContact(contactId: string): Promise<boolean> {
  const age = monitoredCache ? Date.now() - monitoredCache.at : Infinity;
  if (monitoredCache && age < 5 * 60 * 1000 && monitoredCache.set.has(contactId)) return true;
  if (monitoredCache && age < 60 * 1000) return false;
  return (await loadMonitored()).has(contactId);
}
const NOTE_EVENTS = new Set(["NoteCreate", "NoteUpdate", "NoteDelete"]);

/** Events TradeDesk acts on. Anything else is answered 200 and dropped. */
async function ignoreReason(ev: any): Promise<string | null> {
  const type: string = ev.type || "";
  if (type === "INSTALL" || type === "UNINSTALL") return null;
  if (ev.locationId && DEFAULT_LOCATION && ev.locationId !== DEFAULT_LOCATION) return "other location";
  if (type === "ContactUpdate" || type === "ContactDelete") return null;
  if (NOTE_EVENTS.has(type)) {
    if (!ev.contactId) return type === "NoteDelete" ? null : "note without a contact";
    try { return (await isMonitoredContact(ev.contactId)) ? null : "contact not on a monitored-pipeline job"; }
    catch { return null; } // can't tell: store it and let the database decide
  }
  // Every Opportunity* event, OpportunityDelete included (v6), is dropped when
  // it names another pipeline. A delete with no pipelineId is still handled.
  if (type.startsWith("Opportunity")) {
    if (ev.pipelineId && ev.pipelineId !== PIPELINE) return "not the Production pipeline";
    return null;
  }
  return "unhandled type " + type;
}

// ---------- event handlers ----------
async function handle(ev: any): Promise<{ result: unknown; error?: string }> {
  const type: string = ev.type || "";
  const loc: string = ev.locationId || DEFAULT_LOCATION;

  if (type === "INSTALL" || type === "UNINSTALL") {
    if (type === "UNINSTALL" && ev.locationId) {
      await db().rpc("ghl_mark_uninstalled", { p_location_id: ev.locationId });
    }
    await logSync({ direction: "in", entity: "install", action: type.toLowerCase() + "_webhook", ok: true,
                    ghl_id: ev.locationId || ev.companyId || null, source: "marketplace_webhook",
                    detail: { installType: ev.installType ?? null, appId: ev.appId ?? null } });
    if (type === "INSTALL" && ev.locationId === DEFAULT_LOCATION && ev.companyId) {
      try { await exchangeLocationToken(ev.companyId, ev.locationId); }
      catch (e) { return { result: { noted: type }, error: "reconnect failed: " + String(e) }; }
      return { result: { noted: type, reconnected: true } };
    }
    return { result: { noted: type } };
  }

  if (loc !== DEFAULT_LOCATION) return { result: { ignored: "other location " + loc } };

  if (type === "ContactUpdate") {
    const { data, error } = await db().rpc("ghl_apply_contact_event", {
      p_contact_id: ev.id, p_email: ev.email ?? null, p_phone: ev.phone ?? null });
    if (error) return { result: null, error: error.message };
    if ((data?.jobs_updated ?? 0) > 0) {
      await logSync({ direction: "in", entity: "contact", action: "contact_update", ok: true,
                      ghl_id: ev.id, source: "marketplace_webhook", detail: data });
    }
    return { result: data };
  }

  if (type === "ContactDelete") {
    await logSync({ direction: "in", entity: "contact", action: "contact_deleted_in_crm", ok: true,
                    ghl_id: ev.id, source: "marketplace_webhook" });
    return { result: { noted: "ContactDelete" } };
  }

  if (NOTE_EVENTS.has(type)) {
    if (type === "NoteDelete") {
      const { data, error } = await db().rpc("contact_notes_mark_deleted", { p_note: ev.id });
      if (error) return { result: null, error: error.message };
      return { result: { note_deleted: data } };
    }
    // contact_notes_upsert re-checks that the contact is monitored.
    const note = { id: ev.id, contactId: ev.contactId, body: ev.body ?? ev.bodyText ?? "",
                   userId: ev.userId || null, dateAdded: ev.dateAdded || null };
    const { data, error } = await db().rpc("contact_notes_upsert", { p_notes: [note] });
    if (error) return { result: null, error: error.message };
    return { result: data };
  }

  if (type === "OpportunityDelete") {
    const { data: job } = await db().from("jobs").select("id,number").eq("ghl_opportunity_id", ev.id).maybeSingle();
    await logSync({ direction: "in", entity: "opportunity", action: "opportunity_deleted_in_crm", ok: true,
                    ghl_id: ev.id, job_id: job?.id ?? null, source: "marketplace_webhook",
                    detail: { job_number: job?.number ?? null, note: "job left untouched" } });
    return { result: { noted: "OpportunityDelete", job: job?.number ?? null } };
  }

  if (type.startsWith("Opportunity")) {
    if (ev.pipelineId && ev.pipelineId !== PIPELINE) return { result: { ignored: "not the Production pipeline" } };
    const got = await crm.opportunity(ev.id, loc);
    const o = got.body?.opportunity;
    if (!got.ok || !o) return { result: null, error: "opportunity read failed: HTTP " + got.status };
    if (o.pipelineId !== PIPELINE) return { result: { ignored: "not the Production pipeline" } };

    const rec = normalise(o, await stageNames(loc));
    const { data, error } = await db().rpc("ghl_apply_opportunity_event", { p_record: rec });
    if (error) return { result: null, error: error.message };
    await logSync({ direction: "in", entity: "opportunity", action: type, ok: Boolean(data?.applied),
                    ghl_id: o.id, job_id: data?.job_id ?? null, source: "marketplace_webhook",
                    detail: { stage: rec.stage_name, status: rec.status, result: data,
                              signed_date: rec.contract_signed_date, materials_date: rec.materials_ordered_date,
                              warnings: rec._date_warnings.length ? rec._date_warnings : undefined } });
    return { result: data };
  }

  return { result: { ignored: "unhandled type " + type } };
}

/** Store the delivery, retrying transient errors. Returns false for a duplicate or a store that never succeeded. */
async function store(webhookId: string, ev: any): Promise<boolean> {
  const waits = [0, 400, 1200, 3000, 6000];
  let last: unknown = null;
  for (const w of waits) {
    if (w) await sleep(w);
    const ins = await db().from("ghl_webhook_events").insert({
      webhook_id: webhookId, type: ev.type || "unknown", location_id: ev.locationId || null,
      payload: ev, signature_ok: true,
    });
    if (!ins.error) return true;
    if (ins.error.code === "23505") return false; // retry of a delivery we already have
    last = ins.error;
  }
  console.error("ghl_webhook_events insert failed after retries", webhookId, ev.type, last);
  await logSync({ direction: "in", entity: ev.type?.startsWith?.("Contact") ? "contact" : "opportunity",
                  action: "webhook_store_failed", ok: false, ghl_id: ev.id ?? null,
                  source: "marketplace_webhook", detail: { webhookId, type: ev.type, error: last } });
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const raw = await req.text();
  const sig = req.headers.get("x-ghl-signature");
  if (!sig || !verify(raw, sig)) return json(401, { error: "invalid signature" });

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return json(400, { error: "body is not JSON" }); }
  const webhookId: string = ev.webhookId || ev.webhook_id || "";
  if (!webhookId) return json(400, { error: "no webhookId" });

  const skip = await ignoreReason(ev);
  if (skip) return json(200, { ok: true, ignored: skip });

  const work = (async () => {
    try {
      if (!(await store(webhookId, ev))) return;
      let out: { result: unknown; error?: string };
      try { out = await handle(ev); } catch (e) { out = { result: null, error: String(e) }; }
      await db().from("ghl_webhook_events")
        .update({ processed_at: new Date().toISOString(), error: out.error ?? null })
        .eq("webhook_id", webhookId);
    } catch (e) {
      console.error("webhook background work failed", webhookId, e);
    }
  })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;

  return json(200, { ok: true });
});
