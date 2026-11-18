import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Two-way reconciliation between GoHighLevel and TradeDesk.
 *
 * FORWARD  every Open opportunity in the Production Pipeline, read in full.
 * REVERSE  every job TradeDesk still calls open that the forward pass did not
 *          return, matched to the pipeline by name.
 *
 * 2026-11-12: the sweep NEVER creates jobs. ghl_sync_opportunities (-> _core with
 * p_allow_create = false) updates linked jobs and writes an open contract with no
 * job to public.contract_flags; job_flags_digest() emails the list each morning.
 * Only the app webhook (td-app-webhook) creates jobs, and it links first.
 * A database error from the RPC now marks the run failed instead of OK.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PIT = (Deno.env.get("GHL_PIT") || "").trim();
const LOCATION = (Deno.env.get("GHL_LOCATION_ID") || "").trim();

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const PIPELINE = "ynllopdoIURk6CKPtjNg";

// Project type: "Opportunity Project Type" was recreated 2026-11-10 with a new id
// (ahJkRoMCrPBqkmwmKsIO). The deleted field S8XE5l2bsQHtrIk17aEp still returns its
// stale values on reads; it is used only as a fallback while the new field is blank.
const F = {
  display: "0PyQD5I2itCf0nOdpHSF", street: "1HUElXdGFLyqwVFViCYd", address: "1LjzVxPu7WzexHsSi8bf",
  city: "WPsoqqsi5vlPALc01YDc", state: "zL8uHsMCVCp5j0riG2Qb", zip: "Q0FLnbxGalma3kngxfhV",
  type: "ahJkRoMCrPBqkmwmKsIO", typeOld: "S8XE5l2bsQHtrIk17aEp", signed: "tWVSxfJFeGsiORG7YKvI",
  initial: "SVBKQ6EleZredSd52sZm", second: "jYZA4f0mYU2RtXJ7kPcS", final: "kfFVvk26Zw5WB8EwsvEx",
  notes: "oynp2kmyX4EVBCeU39Ob",
};

const svc = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "content-type": "application/json" };
const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function ghl(path: string) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + PIT, Version: VERSION, Accept: "application/json" } });
  const t = await res.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t.slice(0, 200); }
  return { status: res.status, ok: res.ok, body };
}
async function ghlRetry(path: string, wants: (b: any) => boolean, attempts = 3) {
  let last: any = null;
  for (let i = 0; i < attempts; i++) {
    const r = await ghl(path);
    if (r.ok && wants(r.body)) return r;
    last = r;
    if (r.status === 404) break;
    await sleep(400 * (i + 1));
  }
  return last;
}
const hasOpp = (b: any) => Boolean(b?.opportunity);

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
  const cf = new Map<string, unknown>((o.customFields || []).map((f: any) => [f.id, f.fieldValue]));
  const street = txt(cf, F.street) || txt(cf, F.address);
  const city = txt(cf, F.city), st = txt(cf, F.state), zip = txt(cf, F.zip);
  return {
    opportunity_id: o.id, display_id: txt(cf, F.display),
    contact_id: o.contact?.id || null,
    name: o.name || o.contact?.name || null,
    status: o.status || "open",
    stage_name: stageName.get(o.pipelineStageId) || null,
    monetary_value: o.monetaryValue ?? null,
    signed_value: amt(cf, F.signed),
    project_type: txt(cf, F.type) || txt(cf, F.typeOld),
    address: [street, [city, st].filter(Boolean).join(", "), zip].filter(Boolean).join(" ").trim(),
    phone: o.contact?.phone || null, email: o.contact?.email || null,
    notes: txt(cf, F.notes),
    payments: { initial: amt(cf, F.initial), second: amt(cf, F.second), final: amt(cf, F.final) },
    created_at: o.createdAt || null, updated_at: o.updatedAt || null,
  };
}

async function enumerate(statusParam: string, stageName: Map<string, string>) {
  const out: any[] = [];
  let page = 1;
  while (page <= 12) {
    const r = await ghl(`/opportunities/search?location_id=${LOCATION}&pipeline_id=${PIPELINE}&limit=100&page=${page}${statusParam}`);
    if (!r.ok) return { ok: false, status: r.status, list: out };
    const list: any[] = r.body?.opportunities || [];
    for (const o of list) out.push(o);
    if (list.length < 100) break;
    page++;
  }
  return { ok: true, status: 200, list: out };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : url.searchParams.get("token");
  if (!token) return json(401, { error: "missing token" });
  const cred = await fetch(SUPABASE_URL + "/rest/v1/webhook_credentials?id=eq.ghl_admin&select=secret_hash",
    { headers: svc }).then((r) => r.json()).catch(() => null);
  if (!cred?.[0]?.secret_hash || !safeEq(await sha256Hex(token), cred[0].secret_hash)) return json(401, { error: "bad token" });

  const dry = url.searchParams.get("dry") === "1";
  const [run] = await fetch(SUPABASE_URL + "/rest/v1/ghl_sync_runs", {
    method: "POST", headers: { ...svc, Prefer: "return=representation" },
    body: JSON.stringify({ mode: dry ? "sweep-dry" : "sweep" }),
  }).then((r) => r.json());
  const notes: string[] = [];
  const finish = (patch: Record<string, unknown>) =>
    fetch(SUPABASE_URL + "/rest/v1/ghl_sync_runs?id=eq." + run.id, {
      method: "PATCH", headers: svc,
      body: JSON.stringify({ finished_at: new Date().toISOString(), ...patch }) });

  const pipes = await ghl("/opportunities/pipelines?locationId=" + LOCATION);
  const prod = (pipes.body?.pipelines || []).find((p: any) => p.id === PIPELINE);
  const stageName = new Map<string, string>((prod?.stages || []).map((s: any) => [s.id, s.name]));

  /* forward */
  const openList = await enumerate("&status=open", stageName);
  if (!openList.ok) {
    await finish({ ok: false, notes: ["enumeration failed: " + openList.status] });
    return json(200, { runId: run.id, error: "enumeration failed", status: openList.status });
  }
  const ids = openList.list.map((o) => o.id);

  const records: any[] = [];
  const failures: string[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const got = await Promise.all(batch.map((id: string) => ghlRetry("/opportunities/" + id, hasOpp)));
    got.forEach((g, n) => {
      const o = g?.body?.opportunity;
      if (!o) { failures.push(batch[n]); return; }
      records.push(normalise(o, stageName));
    });
    await sleep(300);
  }

  /* reverse */
  const seen = new Set(records.map((r) => r.opportunity_id));
  const openJobs: any[] = await fetch(
    SUPABASE_URL + "/rest/v1/jobs?ghl_status=eq.open&select=id,number,customer_name,contract_amount,ghl_opportunity_id,ghl_project_display_id",
    { headers: svc }).then((r) => r.json()).catch(() => []);
  const orphans = openJobs.filter((j) => !j.ghl_opportunity_id || !seen.has(j.ghl_opportunity_id));

  const resolved: any[] = [];
  const unresolved: any[] = [];

  if (orphans.length) {
    const all = await enumerate("", stageName);
    if (!all.ok) {
      notes.push("reverse pass skipped: full enumeration failed (" + all.status + ")");
    } else {
      const byName = new Map<string, any[]>();
      for (const o of all.list) {
        const k = norm(o.name || o.contact?.name || "");
        if (!k) continue;
        (byName.get(k) || byName.set(k, []).get(k)!).push(o);
      }
      for (const j of orphans) {
        let hit: any = null;
        if (j.ghl_opportunity_id) {
          hit = all.list.find((o) => o.id === j.ghl_opportunity_id) || null;
        }
        if (!hit) {
          const cands = byName.get(norm(j.customer_name)) || [];
          if (cands.length === 1) hit = cands[0];
          else if (cands.length > 1) {
            const want = Number(j.contract_amount || 0);
            const exact = cands.filter((c) => Math.abs(Number(c.monetaryValue || 0) - want) < 0.01);
            if (exact.length === 1) hit = exact[0];
            else {
              unresolved.push({ number: j.number, name: j.customer_name,
                                reason: cands.length + " opportunities with this name, none matched on value" });
              continue;
            }
          }
        }
        if (!hit) {
          unresolved.push({ number: j.number, name: j.customer_name,
                            display_id: j.ghl_project_display_id,
                            reason: "no opportunity of that name in the Production Pipeline" });
          continue;
        }
        const d = await ghlRetry("/opportunities/" + hit.id, hasOpp);
        const o = d?.body?.opportunity;
        if (!o) {
          unresolved.push({ number: j.number, name: j.customer_name, reason: "detail fetch failed for " + hit.id });
          continue;
        }
        // A name match is only a lead. The record goes to the database, which links it
        // only by opportunity id or project #; anything else becomes a contract flag.
        const rec = normalise(o, stageName);
        records.push(rec);
        resolved.push({ number: j.number, name: j.customer_name, status: rec.status,
                        stage: rec.stage_name, opportunity_id: rec.opportunity_id });
        await sleep(150);
      }
    }
  }

  if (resolved.length) notes.push("reverse pass resolved " + resolved.length + " job(s)");
  if (unresolved.length) notes.push("reverse pass left " + unresolved.length + " unresolved");

  if (dry) {
    await finish({ ok: true, enumerated: ids.length, fetched: records.length, fetch_failures: failures.length,
                   notes: [...notes, "dry run — nothing written"] });
    return json(200, { runId: run.id, dryRun: true, enumerated: ids.length, toApply: records.length,
                       fetchFailures: failures.length, resolved, unresolved });
  }
  if (failures.length > ids.length * 0.05) {
    await finish({ ok: false, enumerated: ids.length, fetched: records.length, fetch_failures: failures.length,
                   notes: [...notes, "aborted: too many fetch failures"] });
    return json(200, { runId: run.id, aborted: true, fetchFailures: failures.length });
  }

  const rpc = await fetch(SUPABASE_URL + "/rest/v1/rpc/ghl_sync_opportunities", {
    method: "POST", headers: svc, body: JSON.stringify({ p_records: records, p_run_id: run.id }),
  });
  const applied = await rpc.json().catch(() => null);
  if (!rpc.ok || !applied || typeof applied !== "object" || !("updated" in applied)) {
    const err = "database step failed: HTTP " + rpc.status + " " + JSON.stringify(applied).slice(0, 300);
    await finish({ ok: false, enumerated: ids.length, fetched: records.length,
                   fetch_failures: failures.length, notes: [...notes, err] });
    return json(200, { runId: run.id, error: err });
  }

  await finish({ ok: true, enumerated: ids.length, fetched: records.length,
                 fetch_failures: failures.length, notes: notes.length ? notes : null });
  return json(200, { runId: run.id, enumerated: ids.length, applied,
                     fetchFailures: failures.length, resolved, unresolved });
});
