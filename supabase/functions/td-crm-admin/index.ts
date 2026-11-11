import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { crm, db, logSync } from "../_shared/crm-client.ts";

/**
 * Admin writes to GHL through the marketplace-app token. Auth: the `ghl_admin`
 * credential (same as ghl-sync / ghl-outbound / td-crm-health).
 *
 * POST { action: "set_values", dry?: boolean, items: [{ job_number, opportunity_id, value }] }
 *   Sets each opportunity's monetaryValue (the Opportunity Value). Reads first
 *   (skips if already equal, refuses anything outside the Production pipeline),
 *   writes, then re-reads to CONFIRM, as ghl-outbound does for stages. Sends
 *   pipelineId / pipelineStageId / assignedTo back unchanged so the write can
 *   never move or unassign the card.
 */

const PIPELINE = Deno.env.get("GHL_PRODUCTION_PIPELINE_ID") || "ynllopdoIURk6CKPtjNg";
const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const same = (a: unknown, b: number) => Math.abs(Number(a ?? 0) - b) < 0.005;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return json(401, { error: "missing token" });
  const { data: cred } = await db().from("webhook_credentials").select("secret_hash").eq("id", "ghl_admin").maybeSingle();
  if (!cred?.secret_hash || !safeEq(await sha256Hex(token), cred.secret_hash)) return json(401, { error: "bad token" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "body must be JSON" }); }
  if (body?.action !== "set_values" || !Array.isArray(body.items)) return json(400, { error: "unknown action" });
  const dry = Boolean(body.dry);

  const results: any[] = [];
  for (const it of body.items) {
    const value = Math.round(Number(it.value) * 100) / 100;
    const base = { job: it.job_number, opportunity_id: it.opportunity_id, value };
    if (!it.opportunity_id || !Number.isFinite(value)) { results.push({ ...base, outcome: "bad item" }); continue; }

    const cur = await crm.opportunity(it.opportunity_id);
    const o = cur.body?.opportunity;
    if (!cur.ok || !o) { results.push({ ...base, outcome: "read failed", status: cur.status }); continue; }
    if (o.pipelineId !== PIPELINE) { results.push({ ...base, outcome: "not in Production pipeline", name: o.name }); continue; }
    if (same(o.monetaryValue, value)) { results.push({ ...base, outcome: "already set", name: o.name }); continue; }
    if (dry) { results.push({ ...base, outcome: "would set", name: o.name, from: o.monetaryValue ?? null }); continue; }

    const patch: Record<string, unknown> = { monetaryValue: value, pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId };
    if (o.assignedTo) patch.assignedTo = o.assignedTo;
    const put = await crm.updateOpportunity(it.opportunity_id, patch);
    if (!put.ok) {
      results.push({ ...base, outcome: "write failed", status: put.status, body: JSON.stringify(put.body).slice(0, 200) });
      await logSync({ direction: "out", entity: "opportunity", action: "set_value", ok: false, ghl_id: it.opportunity_id,
                      source: "td-crm-admin", detail: { job: it.job_number, value, status: put.status } });
      continue;
    }
    await sleep(800);
    const after = await crm.opportunity(it.opportunity_id);
    const now = after.body?.opportunity?.monetaryValue;
    const ok = same(now, value);
    results.push({ ...base, outcome: ok ? "set (confirmed)" : "not applied", name: o.name, from: o.monetaryValue ?? null, now });
    await logSync({ direction: "out", entity: "opportunity", action: "set_value", ok, ghl_id: it.opportunity_id,
                    source: "td-crm-admin", detail: { job: it.job_number, from: o.monetaryValue ?? null, to: value, confirmed: now } });
    await sleep(150);
  }
  return json(200, { dry, count: results.length, results });
});
