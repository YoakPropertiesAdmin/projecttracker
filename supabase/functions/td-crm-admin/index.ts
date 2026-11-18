import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { crm, db, DEFAULT_LOCATION, ghlFetch, logSync } from "../_shared/crm-client.ts";

/**
 * Admin writes to GHL through the marketplace-app token. Auth: the `ghl_admin`
 * credential (same as ghl-sync / ghl-outbound / td-crm-health).
 *
 * POST { action: "set_values", dry?: boolean, items: [{ job_number, opportunity_id, value }] }
 * POST { action: "list_users" } / { action: "sync_users" }
 * POST { action: "backfill_dry_run", run_id, offset, limit }   READ-ONLY -> ghl_backfill_plan
 * POST { action: "backfill_schema", run_id }                    READ-ONLY -> ghl_backfill_plan
 * POST { action: "apply_fields", run_id, items: [{ job_number, job_id, opportunity_id,
 *        project_type?, signed_value?, monetary_value? }] }
 *   Background. Per item: read the opportunity (Production pipeline only), write
 *   only the fields that differ, keep pipeline/stage/owner, re-read and confirm.
 *   One result row per item in ghl_backfill_plan (item 'write') with before/after.
 *
 * Project type: GHL field "Opportunity Project Type" (opportunity.opportunity_project_type,
 * TEXT) id ahJkRoMCrPBqkmwmKsIO, created 2026-11-10. The old id S8XE5l2bsQHtrIk17aEp was
 * deleted; GHL still returns its stale values on reads but drops writes to it.
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

// ---------- backfill helpers ----------
const CF = {
  signedValue: "tWVSxfJFeGsiORG7YKvI", type: "ahJkRoMCrPBqkmwmKsIO",
  signedDate: "IIJDGI3z2bESbPQfNuDe", materialsDate: "7U5wuHNq6LjUMuseVipP",
};
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
function parseGhlDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "null") return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return ymd(+m[3], +m[1], +m[2]);
  return null;
}
const cfMap = (o: any) => new Map<string, unknown>((o?.customFields || []).map((f: any) =>
  [f.id, f.fieldValue ?? f.value ?? f.fieldValueString ?? f.fieldValueDate ?? f.fieldValueNumber]));
const cfText = (m: Map<string, unknown>, id: string) => {
  const v = m.get(id);
  if (v === null || v === undefined) return null;
  const s = Array.isArray(v) ? v.join(" / ") : String(v).trim();
  return s === "" || s.toLowerCase() === "null" ? null : s;
};
const cfNum = (m: Map<string, unknown>, id: string) => {
  const t = cfText(m, id); if (t === null) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null;
};
const TRADE_ORDER: [string, string][] = [
  ["roofing", "Roofing"], ["siding", "Siding"], ["windows", "Windows"], ["doors", "Doors"],
  ["gutters", "Gutters"], ["soffit_fascia", "Soffit / Fascia / Trim"], ["other", "Other"],
];
function projectType(trades: string[] | null, repair: boolean | null): string | null {
  const t = new Set(trades || []);
  const parts = TRADE_ORDER.filter(([k]) => t.has(k)).map(([, v]) => v);
  if (!parts.length) return null;
  return parts.join(" / ") + (repair ? " Repair" : "");
}
const normNote = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

async function backfillDryRun(runId: string, offset: number, limit: number) {
  const { data: jobs, error } = await db().from("jobs")
    .select("id,number,customer_name,ghl_opportunity_id,ghl_contact_id,contract_signed_date,materials_ordered_date,contract_amount,trades,is_repair,notes,ghl_status,stage")
    .not("ghl_opportunity_id", "is", null).order("number").range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const j of jobs || []) {
    const rows: any[] = [];
    const base = { run_id: runId, job_id: j.id, job_number: j.number, opportunity_id: j.ghl_opportunity_id };
    const got = await crm.opportunity(j.ghl_opportunity_id);
    const o = got.body?.opportunity;
    if (!got.ok || !o) {
      rows.push({ ...base, item: "opportunity", action: "read_failed", detail: { status: got.status } });
      await db().from("ghl_backfill_plan").insert(rows); continue;
    }
    const contactId = j.ghl_contact_id || o.contactId || o.contact?.id || null;
    const ctx = { name: j.customer_name, opp_name: o.name, pipeline_ok: o.pipelineId === PIPELINE,
                  status: o.status, monetary_value: o.monetaryValue ?? null, td_status: j.ghl_status, td_stage: j.stage };
    const b2 = { ...base, contact_id: contactId };
    if (o.pipelineId !== PIPELINE) {
      rows.push({ ...b2, item: "opportunity", action: "skip_not_production", detail: ctx });
    } else {
      const cf = cfMap(o);
      for (const [item, id, td] of [["signed_date", CF.signedDate, j.contract_signed_date], ["materials_date", CF.materialsDate, j.materials_ordered_date]] as [string, string, string | null][]) {
        const rawG = cfText(cf, id); const g = parseGhlDate(cf.get(id));
        let action: string;
        if (!td) action = "skip_td_empty";
        else if (rawG && !g) action = "would_set_unreadable_ghl";
        else if (!g) action = "would_fill";
        else if (g === td) action = "same";
        else action = "would_change";
        rows.push({ ...b2, item, action, td_value: td, ghl_value: rawG, detail: ctx });
      }
      {
        const rawG = cfText(cf, CF.signedValue);
        const g = cfNum(cf, CF.signedValue);
        const td = j.contract_amount === null ? null : Number(j.contract_amount);
        let action: string;
        if (td === null) action = "skip_td_empty";
        else if (td === 0) action = g === null || g === 0 ? "same" : "would_zero_review";
        else if (g === null) action = "would_fill";
        else if (same(g, td)) action = "same";
        else action = "would_change";
        rows.push({ ...b2, item: "signed_value", action, td_value: td === null ? null : td.toFixed(2), ghl_value: rawG, detail: ctx });
      }
      {
        const rawG = cfText(cf, CF.type);
        const td = projectType(j.trades, j.is_repair);
        let action: string;
        if (!td) action = "skip_td_empty";
        else if (!rawG) action = "would_fill";
        else if (rawG === td) action = "same";
        else action = "would_change";
        rows.push({ ...b2, item: "project_type", action, td_value: td, ghl_value: rawG, detail: ctx });
      }
    }
    const note = (j.notes || "").trim();
    if (!note) rows.push({ ...b2, item: "note", action: "skip_td_empty" });
    else if (!contactId) rows.push({ ...b2, item: "note", action: "skip_no_contact", td_value: note.slice(0, 500) });
    else {
      const nr = await ghlFetch("/contacts/" + contactId + "/notes");
      if (!nr.ok) rows.push({ ...b2, item: "note", action: "notes_read_failed", td_value: note.slice(0, 500), detail: { status: nr.status, body: JSON.stringify(nr.body).slice(0, 300) } });
      else {
        const list: any[] = nr.body?.notes || [];
        const want = normNote(note);
        const hit = list.find((x) => { const b = normNote(String(x.body || "")); return b === want || b.includes(want) || (b.length > 20 && want.includes(b)); });
        rows.push({ ...b2, item: "note", action: hit ? "same" : "would_create", td_value: note.slice(0, 500),
                    ghl_value: hit ? String(hit.body || "").slice(0, 300) : null,
                    detail: { existing_notes: list.length, latest: list[0] ? { at: list[0].dateAdded, body: String(list[0].body || "").slice(0, 200) } : null } });
      }
    }
    await db().from("ghl_backfill_plan").insert(rows);
    n++;
  }
  await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "chunk", action: "done", detail: { offset, limit, jobs: n } });
}

async function backfillSchema(runId: string) {
  const out: any[] = [];
  const objs = await ghlFetch("/objects/?locationId=" + DEFAULT_LOCATION);
  out.push({ run_id: runId, item: "schema", action: objs.ok ? "objects" : "objects_failed", detail: { status: objs.status, body: objs.body } });
  const custom = (objs.body?.objects || []).filter((o: any) => String(o.key || "").startsWith("custom_objects."));
  for (const o of custom) {
    const s = await ghlFetch("/objects/" + encodeURIComponent(o.key) + "?locationId=" + DEFAULT_LOCATION + "&fetchProperties=true");
    out.push({ run_id: runId, item: "schema", action: s.ok ? "object_detail" : "object_detail_failed", td_value: o.key, detail: { status: s.status, body: s.body } });
    const rec = await ghlFetch("/objects/" + encodeURIComponent(o.key) + "/records/search", { method: "POST",
      body: JSON.stringify({ locationId: DEFAULT_LOCATION, page: 1, pageLimit: 5, query: "" }) });
    out.push({ run_id: runId, item: "schema", action: rec.ok ? "records_sample" : "records_failed", td_value: o.key, detail: { status: rec.status, body: rec.body } });
  }
  const assoc = await ghlFetch("/associations/?locationId=" + DEFAULT_LOCATION + "&skip=0&limit=100");
  out.push({ run_id: runId, item: "schema", action: assoc.ok ? "associations" : "associations_failed", detail: { status: assoc.status, body: assoc.body } });
  await db().from("ghl_backfill_plan").insert(out);
}

// ---------- apply_fields ----------
function snapshot(o: any) {
  const cf = cfMap(o);
  return { project_type: cfText(cf, CF.type), signed_value: cfNum(cf, CF.signedValue),
           monetary_value: o?.monetaryValue ?? null };
}

async function applyFields(runId: string, items: any[]) {
  for (const it of items) {
    const base = { run_id: runId, item: "write", job_id: it.job_id ?? null, job_number: it.job_number ?? null, opportunity_id: it.opportunity_id };
    const want: any = {
      project_type: it.project_type ?? null,
      signed_value: it.signed_value === undefined || it.signed_value === null ? null : Math.round(Number(it.signed_value) * 100) / 100,
      monetary_value: it.monetary_value === undefined || it.monetary_value === null ? null : Math.round(Number(it.monetary_value) * 100) / 100,
    };
    try {
      const cur = await crm.opportunity(it.opportunity_id);
      const o = cur.body?.opportunity;
      if (!cur.ok || !o) { await db().from("ghl_backfill_plan").insert({ ...base, action: "read_failed", detail: { status: cur.status, want } }); continue; }
      if (o.pipelineId !== PIPELINE) { await db().from("ghl_backfill_plan").insert({ ...base, action: "skip_not_production", detail: { want } }); continue; }
      const before = snapshot(o);
      const customFields: any[] = [];
      const changed: string[] = [];
      if (want.project_type !== null && before.project_type !== want.project_type) {
        customFields.push({ id: CF.type, field_value: want.project_type }); changed.push("project_type");
      }
      if (want.signed_value !== null && (before.signed_value === null || !same(before.signed_value, want.signed_value))) {
        customFields.push({ id: CF.signedValue, field_value: want.signed_value }); changed.push("signed_value");
      }
      const patch: Record<string, unknown> = { pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId };
      if (o.assignedTo) patch.assignedTo = o.assignedTo;
      if (want.monetary_value !== null && !same(o.monetaryValue, want.monetary_value)) {
        patch.monetaryValue = want.monetary_value; changed.push("monetary_value");
      }
      if (!changed.length) { await db().from("ghl_backfill_plan").insert({ ...base, action: "already_set", detail: { before, want } }); continue; }
      if (customFields.length) patch.customFields = customFields;

      const put = await crm.updateOpportunity(it.opportunity_id, patch);
      if (!put.ok) {
        await db().from("ghl_backfill_plan").insert({ ...base, action: "write_failed", detail: { status: put.status, body: JSON.stringify(put.body).slice(0, 400), before, want, changed } });
        await logSync({ direction: "out", entity: "opportunity", action: "backfill_fields", ok: false, ghl_id: it.opportunity_id,
                        job_id: it.job_id ?? null, source: "td-crm-admin", detail: { run_id: runId, status: put.status, changed } });
        continue;
      }
      await sleep(800);
      const after_r = await crm.opportunity(it.opportunity_id);
      const after = snapshot(after_r.body?.opportunity);
      const bad = changed.filter((k) => k === "project_type" ? after.project_type !== want.project_type
                                       : !same((after as any)[k], (want as any)[k]));
      const action = bad.length ? "not_applied" : "confirmed";
      await db().from("ghl_backfill_plan").insert({ ...base, action, detail: { before, after, want, changed, not_applied: bad } });
      await logSync({ direction: "out", entity: "opportunity", action: "backfill_fields", ok: !bad.length, ghl_id: it.opportunity_id,
                      job_id: it.job_id ?? null, source: "td-crm-admin", detail: { run_id: runId, job: it.job_number, before, after, changed } });
      await sleep(150);
    } catch (e) {
      await db().from("ghl_backfill_plan").insert({ ...base, action: "error", detail: { error: String(e), want } });
    }
  }
  await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "chunk", action: "done", detail: { items: items.length } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return json(401, { error: "missing token" });
  const { data: cred } = await db().from("webhook_credentials").select("secret_hash").eq("id", "ghl_admin").maybeSingle();
  if (!cred?.secret_hash || !safeEq(await sha256Hex(token), cred.secret_hash)) return json(401, { error: "bad token" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "body must be JSON" }); }

  if (body?.action === "backfill_dry_run" || body?.action === "backfill_schema" || body?.action === "apply_fields") {
    const runId = String(body.run_id || "");
    if (!runId) return json(400, { error: "run_id required" });
    if (body.action === "apply_fields" && (!Array.isArray(body.items) || body.items.length > 60)) return json(400, { error: "items: array of at most 60" });
    const work = (async () => {
      try {
        if (body.action === "backfill_schema") await backfillSchema(runId);
        else if (body.action === "apply_fields") await applyFields(runId, body.items);
        else await backfillDryRun(runId, Math.max(0, Number(body.offset) || 0), Math.min(80, Math.max(1, Number(body.limit) || 40)));
      } catch (e) {
        await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "chunk", action: "error", detail: { error: String(e), offset: body.offset } });
      }
    })();
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(work); else await work;
    return json(202, { accepted: true, run_id: runId });
  }

  if (body?.action === "list_users" || body?.action === "sync_users") {
    const r = await ghlFetch("/users/?locationId=" + DEFAULT_LOCATION);
    const users = (r.body?.users || []).map((u: any) => ({
      id: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" "),
      email: u.email, role: u.roles?.role ?? null, type: u.roles?.type ?? null, deleted: u.deleted ?? false,
    }));
    if (body.action === "list_users") return json(r.ok ? 200 : r.status, { status: r.status, count: users.length, users });
    if (!r.ok || users.length === 0) {
      await logSync({ direction: "in", entity: "sso", action: "sync_users", ok: false,
                      source: "td-crm-admin", detail: { status: r.status, count: users.length } });
      return json(502, { error: "GHL user list unavailable", status: r.status });
    }
    const { data: n, error } = await db().rpc("ghl_users_replace", { p_users: users });
    await logSync({ direction: "in", entity: "sso", action: "sync_users", ok: !error,
                    source: "td-crm-admin", detail: { count: users.length, upserted: n ?? null, error: error?.message ?? null } });
    return json(error ? 500 : 200, { synced: users.length, error: error?.message ?? null });
  }
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
