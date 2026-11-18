import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { crm, db, DEFAULT_LOCATION, ghlFetch, logSync } from "../_shared/crm-client.ts";

/**
 * TradeDesk -> GHL Jobs / Projects custom-object records. Auth: ghl_admin credential.
 *
 * Scope: every TradeDesk job with a GHL opportunity OR a GHL project #. A Project groups every
 * TradeDesk job carrying its project #. A job with no opportunity of its own (a phase or add-on
 * sale) gets its Job record and Project link; the opportunity steps are skipped for it.
 *
 * POST { action: "sync", run_id, projects?: string[], job_ids?: string[], standalone?: boolean }
 * POST { action: "check", run_id }   READ-ONLY comparison -> public.contract_flags.
 *
 * Find before create (Job Number / Project ID). Every write is re-read.
 * GHL quirks: record create takes locationId in the BODY; update in the QUERY.
 * Multi-select: create takes an array; update needs { add, remove }.
 */

const JOBS = "custom_objects.jobs_tmpl";
const PROJECTS = "custom_objects.projects_tmpl";
const ASSOC_JOB_OPP = "6af63308abf419cfff439b7e";
const ASSOC_JOB_PROJECT = "6af6330c5efde3b1be0afb3c";
const ASSOC_CONTACT_PROJECT = "6adf72379ed849e4730201c7";
const OPP = { street: "1HUElXdGFLyqwVFViCYd", city: "WPsoqqsi5vlPALc01YDc", state: "zL8uHsMCVCp5j0riG2Qb",
              tdJob: "eDhdHzaVsme0lunzagRJ" };
const MONEY = new Set(["price", "budget"]);
const MULTI = new Set(["trades"]);
const NOT_COMPARED = new Set(["city", "state"]);

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
const cfText = (o: any, id: string) => {
  const f = (o?.customFields || []).find((x: any) => x.id === id);
  const v = f ? (f.fieldValue ?? f.value ?? f.fieldValueString ?? f.fieldValueNumber) : null;
  if (v === null || v === undefined) return null;
  const s = String(Array.isArray(v) ? v.join(" ") : v).trim();
  return s ? s : null;
};
function toGhl(props: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = MONEY.has(k) ? { currency: "default", value: Math.round(Number(v) * 100) / 100 } : v;
  }
  return out;
}
function norm(v: any): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "object" && !Array.isArray(v) && "value" in v) return Number(v.value).toFixed(2);
  if (Array.isArray(v)) return [...v].map(String).sort().join(",");
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s).toFixed(2);
  return s.trim();
}
function diff(want: Record<string, any>, got: Record<string, any>, skip = new Set<string>()) {
  const bad: Record<string, any> = {};
  for (const [k, v] of Object.entries(want)) {
    if (skip.has(k)) continue;
    const a = norm(v), b = norm(got?.[k]);
    if (a !== b) bad[k] = { want: v, got: got?.[k] ?? null };
  }
  return bad;
}
async function getLink(kind: string, key: string) {
  const { data } = await db().from("ghl_object_links").select("record_id").eq("kind", kind).eq("td_key", key).maybeSingle();
  return data?.record_id ?? null;
}
async function setLink(kind: string, key: string, recordId: string | null, error: string | null = null) {
  await db().from("ghl_object_links").upsert({ kind, td_key: key, record_id: recordId, synced_at: new Date().toISOString(), error },
    { onConflict: "kind,td_key" });
}
const readRecord = (schema: string, id: string) => ghlFetch(`/objects/${schema}/records/${id}`);

async function listAll(schema: string) {
  const out: any[] = [];
  let after: any = null;
  for (let i = 0; i < 50; i++) {
    const body: any = { locationId: DEFAULT_LOCATION, pageLimit: 100 };
    if (after) body.searchAfter = after; else body.page = 1;
    const r = await ghlFetch(`/objects/${schema}/records/search`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`list ${schema}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const recs: any[] = r.body?.records || [];
    out.push(...recs);
    if (recs.length < 100) break;
    after = recs[recs.length - 1]?.searchAfter;
    if (!after) break;
  }
  return out;
}

async function upsertRecord(schema: string, kind: string, key: string, props: Record<string, any>, existingId: string | null) {
  const properties = toGhl(props);
  let id = await getLink(kind, key);
  let op = "updated";
  if (!id && existingId) { id = existingId; op = "adopted"; }
  let res: any;
  if (id) {
    const cur = await readRecord(schema, id);
    if (cur.status === 404) id = null;
    else {
      const have = cur.body?.record?.properties ?? {};
      const upd: Record<string, any> = {};
      for (const [k, v] of Object.entries(properties)) {
        if (MULTI.has(k)) {
          const w = new Set<string>(v as string[]), h = new Set<string>((have[k] || []) as string[]);
          const add = [...w].filter((x) => !h.has(x)), remove = [...h].filter((x) => !w.has(x));
          if (add.length || remove.length) upd[k] = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
        } else if (norm(v) !== norm(have[k])) upd[k] = v;
      }
      if (!Object.keys(upd).length) { await setLink(kind, key, id); return { ok: true, op: op === "adopted" ? "adopted" : "unchanged", id, mismatch: {} }; }
      res = await ghlFetch(`/objects/${schema}/records/${id}?locationId=${DEFAULT_LOCATION}`,
        { method: "PUT", body: JSON.stringify({ properties: upd }) });
      if (res.status === 404) id = null;
    }
  }
  if (!id) {
    op = "created";
    res = await ghlFetch(`/objects/${schema}/records`,
      { method: "POST", body: JSON.stringify({ locationId: DEFAULT_LOCATION, properties }) });
    if (res.ok) id = res.body?.record?.id ?? res.body?.id ?? null;
  }
  if (!res.ok || !id) {
    await setLink(kind, key, id, `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    return { ok: false, op: op + "_failed", id, status: res.status, body: JSON.stringify(res.body).slice(0, 500) };
  }
  await setLink(kind, key, id);
  await sleep(300);
  const back = await readRecord(schema, id);
  const got = back.body?.record?.properties ?? {};
  const bad = back.ok ? diff(properties, got) : { reread: back.status, body: JSON.stringify(back.body).slice(0, 200) };
  return { ok: Object.keys(bad).length === 0, op, id, mismatch: bad };
}

async function relate(associationId: string, first: string, second: string) {
  const key = `${associationId}|${first}|${second}`;
  if (await getLink("relation", key)) return { ok: true, op: "exists" };
  const r = await ghlFetch("/associations/relations", { method: "POST",
    body: JSON.stringify({ locationId: DEFAULT_LOCATION, associationId, firstRecordId: first, secondRecordId: second }) });
  const txt = JSON.stringify(r.body).slice(0, 300);
  const dup = !r.ok && /already|exist|duplicate/i.test(txt);
  if (r.ok || dup) { await setLink("relation", key, r.body?.id ?? "exists"); return { ok: true, op: dup ? "already_related" : "related" }; }
  return { ok: false, op: "relate_failed", status: r.status, body: txt };
}

async function setOppJobNumber(opp: any, number: number) {
  const want = "JOB-" + number;
  const have = cfText(opp, OPP.tdJob);
  if (have === want) return { ok: true, op: "unchanged" };
  const w = await crm.updateOpportunity(opp.id, { customFields: [{ id: OPP.tdJob, field_value: want }] });
  if (!w.ok) return { ok: false, op: "opp_write_failed", status: w.status, body: JSON.stringify(w.body).slice(0, 300) };
  await sleep(250);
  const back = await crm.opportunity(opp.id);
  const got = cfText(back.body?.opportunity, OPP.tdJob);
  return got === want ? { ok: true, op: have === null ? "opp_set" : "opp_changed", was: have }
                      : { ok: false, op: "opp_not_confirmed", want, got };
}

type Index = { jobs: Map<string, string>; projects: Map<string, string> };

async function syncJob(runId: string, j: any, idx: Index) {
  const base = { run_id: runId, item: "job", job_id: j.job_id, job_number: j.number, opportunity_id: j.opportunity_id, contact_id: j.contact_id };
  const props = { ...j.props };
  let opp: any = null, oStatus: number | null = null;
  if (j.opportunity_id) {
    const o = await crm.opportunity(j.opportunity_id);
    oStatus = o.status;
    opp = o.body?.opportunity ?? null;
    if (opp) {
      const city = cfText(opp, OPP.city), state = cfText(opp, OPP.state), street = cfText(opp, OPP.street);
      if (city) props.city = city;
      if (state) props.state = state;
      if (!props.address && street) props.address = street;
    }
  }
  const rec = await upsertRecord(JOBS, "job", j.job_id, props, idx.jobs.get(String(props.job_number)) ?? null);
  // A job with no opportunity of its own (phase / add-on sale) skips the opportunity steps.
  const noOpp = { ok: true, op: "no_opportunity" };
  const rel = !j.opportunity_id ? noOpp
    : rec.id ? (opp ? await relate(ASSOC_JOB_OPP, rec.id, j.opportunity_id) : { ok: false, op: "opp_unreadable", status: oStatus }) : null;
  const oppField = !j.opportunity_id ? noOpp
    : opp ? await setOppJobNumber(opp, j.number) : { ok: false, op: "opp_unreadable", status: oStatus };
  const ok = rec.ok && rel?.ok && oppField.ok;
  await db().from("ghl_backfill_plan").insert({ ...base, action: ok ? "confirmed" : "problem", td_value: rec.id, detail: { rec, rel, oppField, props } });
  await logSync({ direction: "out", entity: "opportunity", action: "job_record_" + rec.op, ok: !!ok, ghl_id: rec.id, job_id: j.job_id,
                  source: "td-ghl-objects", detail: { run_id: runId, job: j.number, opp_field: oppField.op } });
  return { recordId: rec.id, city: props.city ?? null, state: props.state ?? null };
}

async function payloads(projects: string[] | null) {
  const { data: jobs, error: je } = await db().rpc("ghl_job_object_payloads", { p_numbers: null });
  if (je) throw new Error(je.message);
  const { data: projs, error: pe } = await db().rpc("ghl_project_object_payloads", { p_projects: projects });
  if (pe) throw new Error(pe.message);
  return { jobs: (jobs || []) as any[], projs: (projs || []) as any[] };
}

async function index(): Promise<Index> {
  const [jr, pr] = await Promise.all([listAll(JOBS), listAll(PROJECTS)]);
  const jobs = new Map<string, string>(), projects = new Map<string, string>();
  for (const r of jr) { const k = r.properties?.job_number; if (k && !jobs.has(String(k))) jobs.set(String(k), r.id); }
  for (const r of pr) { const k = r.properties?.project_id ?? r.properties?.project_number;
    if (k !== undefined && k !== null && !projects.has(String(Number(k)))) projects.set(String(Number(k)), r.id); }
  return { jobs, projects };
}

async function runSync(runId: string, projects: string[] | null, jobIds: string[] | null, standalone: boolean) {
  let { jobs, projs } = await payloads(null);
  let soloJobs: any[] = [];
  if (jobIds) {
    const want = new Set(jobIds);
    const hit = jobs.filter((j) => want.has(j.job_id));
    const pns = new Set(hit.filter((j) => j.project_number).map((j) => String(j.project_number)));
    projs = projs.filter((p) => pns.has(String(p.project_number)));
    soloJobs = hit.filter((j) => !j.project_number);
  } else if (projects) {
    const want = new Set(projects.map(String));
    projs = projs.filter((p) => want.has(String(p.project_number)));
    if (standalone) soloJobs = jobs.filter((j) => !j.project_number);
  } else if (standalone) soloJobs = jobs.filter((j) => !j.project_number);

  const idx = await index();
  const byId = new Map<string, any>(jobs.map((x) => [x.job_id, x]));
  let nP = 0, nJ = 0;
  for (const p of projs) {
    const done: Record<string, any> = {};
    for (const jid of p.job_ids as string[]) {
      const j = byId.get(jid); if (!j) continue;
      try { done[jid] = await syncJob(runId, j, idx); nJ++; }
      catch (e) { await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "job", job_id: jid, action: "error", detail: { error: String(e) } }); }
    }
    const props = { ...p.props };
    const first = done[p.first_job];
    if (first?.city) props.city = first.city;
    if (first?.state) props.state = first.state;
    const base = { run_id: runId, item: "project", td_value: p.project_number, contact_id: p.contact_id };
    try {
      const rec = await upsertRecord(PROJECTS, "project", p.project_number, props, idx.projects.get(String(Number(p.project_number))) ?? null);
      const rels: any[] = [];
      if (rec.id) {
        for (const jid of p.job_ids as string[]) {
          const jr = done[jid]?.recordId; if (jr) rels.push({ job: jid, ...(await relate(ASSOC_JOB_PROJECT, jr, rec.id)) });
        }
        if (p.contact_id) rels.push({ contact: p.contact_id, ...(await relate(ASSOC_CONTACT_PROJECT, p.contact_id, rec.id)) });
      }
      const ok = rec.ok && rels.every((r) => r.ok);
      await db().from("ghl_backfill_plan").insert({ ...base, action: ok ? "confirmed" : "problem", ghl_value: rec.id, detail: { rec, rels, props } });
    } catch (e) {
      await db().from("ghl_backfill_plan").insert({ ...base, action: "error", detail: { error: String(e) } });
    }
    nP++;
  }
  for (const j of soloJobs) {
    try { await syncJob(runId, j, idx); nJ++; }
    catch (e) { await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "job", job_id: j.job_id, action: "error", detail: { error: String(e) } }); }
  }
  await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "chunk", action: "done", detail: { projects: nP, jobs: nJ } });
}

const LABEL: Record<string, string> = {
  job_name: "Client Name", job_number: "Job Number", address: "Address", price: "Price", scheduled_date: "Scheduled Date",
  completion_date: "Completion Date", job_status: "Job Status", service_type: "Service Type", trades: "Trades",
  project_manager: "Project Manager", installer: "Installer", payment_status: "Payment Status", opportunity_id: "opportunity id",
  project_name: "Project Name", project_number: "Project Number", project_id: "Project ID", project_address: "Project Address",
  budget: "Budget", start_date: "Start Date", project_status: "Project Status",
};
const show = (v: any) => v === null || v === undefined || v === "" ? "(blank)"
  : typeof v === "object" && !Array.isArray(v) && "value" in v ? "$" + Number(v.value).toFixed(2)
  : Array.isArray(v) ? v.join(", ") : String(v);

async function runCheck(runId: string) {
  const started = new Date().toISOString();
  const { jobs, projs } = await payloads(null);
  const [gj, gp] = await Promise.all([listAll(JOBS), listAll(PROJECTS)]);
  const { data: links } = await db().from("ghl_object_links").select("kind,td_key,record_id").in("kind", ["job", "project"]);
  const linkOf = new Map<string, string>((links || []).map((l: any) => [l.kind + "|" + l.td_key, l.record_id]));
  const gjById = new Map<string, any>(gj.map((r) => [r.id, r]));
  const gpById = new Map<string, any>(gp.map((r) => [r.id, r]));
  const projOf = new Map<string, string>();
  for (const p of projs) for (const jid of p.job_ids) projOf.set(jid, p.project_number);
  const seenIds = new Set<string>();
  const flags: any[] = [];
  const flag = (kind: string, ref: string, name: string, summary: string, extra: any = {}) =>
    flags.push({ source: "ghl_check", kind, ref, name, amount: null, detail: { summary, ...extra }, candidates: null });

  for (const j of jobs) {
    const rid = linkOf.get("job|" + j.job_id);
    const rec = rid ? gjById.get(rid) : null;
    const label = `JOB-${j.number} ${j.props.job_name ?? ""}`.trim();
    if (!rec) { flag("ghl_missing", "job:" + j.job_id, label, "No GHL Job record for this TradeDesk job"); continue; }
    seenIds.add(rec.id);
    const bad = diff(toGhl(j.props), rec.properties || {}, NOT_COMPARED);
    const rels: any[] = rec.relations || [];
    if (j.opportunity_id && !rels.some((x) => x.associationId === ASSOC_JOB_OPP && x.recordId === j.opportunity_id)) bad["link"] = { want: "linked to its opportunity", got: "not linked" };
    if (projOf.has(j.job_id) && !rels.some((x) => x.associationId === ASSOC_JOB_PROJECT)) bad["link "] = { want: "linked to its Project", got: "not linked" };
    if (Object.keys(bad).length) flag("ghl_drift", "job:" + j.job_id, label,
      Object.entries(bad).map(([k, v]: any) => `${LABEL[k.trim()] ?? k.trim()}: GHL ${show(v.got)}, TradeDesk ${show(v.want)}`).join("; "));
  }
  for (const p of projs) {
    const rid = linkOf.get("project|" + p.project_number);
    const rec = rid ? gpById.get(rid) : null;
    const label = `Project ${p.project_number} ${p.props.project_name ?? ""}`.trim();
    if (!rec) { flag("ghl_missing", "project:" + p.project_number, label, "No GHL Project record for this project #"); continue; }
    seenIds.add(rec.id);
    const bad = diff(toGhl(p.props), rec.properties || {}, NOT_COMPARED);
    if (Object.keys(bad).length) flag("ghl_drift", "project:" + p.project_number, label,
      Object.entries(bad).map(([k, v]: any) => `${LABEL[k] ?? k}: GHL ${show(v.got)}, TradeDesk ${show(v.want)}`).join("; "));
  }
  for (const r of [...gj, ...gp]) {
    if (seenIds.has(r.id)) continue;
    const isJob = r.objectKey === JOBS;
    flag("ghl_extra", (isJob ? "jobrec:" : "projrec:") + r.id,
      isJob ? `${r.properties?.job_number ?? "(no Job Number)"} ${r.properties?.job_name ?? ""}`.trim()
            : `Project ${r.properties?.project_number ?? "?"} ${r.properties?.project_name ?? ""}`.trim(),
      `GHL ${isJob ? "Job" : "Project"} record that no TradeDesk ${isJob ? "job" : "project"} owns (duplicate or made by hand)`, { record_id: r.id });
  }
  for (const f of flags) {
    await db().from("contract_flags").upsert({ ...f, last_seen_at: new Date().toISOString(), resolved_at: null, resolution: null },
      { onConflict: "kind,ref" });
  }
  await db().from("contract_flags").update({ resolved_at: new Date().toISOString(), resolution: "matches TradeDesk now" })
    .in("kind", ["ghl_drift", "ghl_missing", "ghl_extra"]).is("resolved_at", null).lt("last_seen_at", started);
  await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "check", action: "done",
    detail: { ghl_jobs: gj.length, ghl_projects: gp.length, td_jobs: jobs.length, td_projects: projs.length,
              drift: flags.filter((f) => f.kind === "ghl_drift").length, missing: flags.filter((f) => f.kind === "ghl_missing").length,
              extra: flags.filter((f) => f.kind === "ghl_extra").length } });
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
  if (!body?.run_id || !["sync", "check"].includes(body?.action)) return json(400, { error: "action sync|check and run_id required" });
  const runId = String(body.run_id);
  const work = (async () => {
    try {
      if (body.action === "check") await runCheck(runId);
      else await runSync(runId, Array.isArray(body.projects) ? body.projects.map(String) : null,
                         Array.isArray(body.job_ids) ? body.job_ids.map(String) : null, Boolean(body.standalone));
    } catch (e) { await db().from("ghl_backfill_plan").insert({ run_id: runId, item: "chunk", action: "error", detail: { error: String(e) } }); }
  })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return json(202, { accepted: true, run_id: runId });
});
