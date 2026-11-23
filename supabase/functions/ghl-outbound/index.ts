import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * TradeDesk -> GoHighLevel write-back.
 *
 * Drains public.ghl_outbound. Each row says: move this opportunity to this
 * stage. The queue exists so a failed CRM call is retried rather than lost.
 *
 * Idempotency and the loop guard both live HERE, not in the database trigger:
 * the opportunity is read from GHL before every write, and skipped if it is
 * already in the target stage. Asking GHL cannot go stale. An earlier version
 * guarded in the trigger by comparing jobs.substage, which silently dropped
 * every write-back for a job whose substage had drifted from reality.
 *
 * After a write the record is re-read and the stage CONFIRMED. A 200 from GHL
 * is not proof the change applied — without this check a write that is ignored,
 * or reverted moments later by a workflow, would be logged as success while
 * nothing moved.
 *
 * A row with no target_stage_name is a STATUS-ONLY write (TradeDesk marked the
 * job lost, or reopened it). Same rules: read first and skip if GHL already has
 * that status, write, then re-read and confirm the status stuck.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PIT = (Deno.env.get("GHL_PIT") || "").trim();
const LOCATION = (Deno.env.get("GHL_LOCATION_ID") || "").trim();

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const PIPELINE = "ynllopdoIURk6CKPtjNg";
const MAX_ATTEMPTS = 5;

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

async function ghl(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + PIT, Version: VERSION,
      Accept: "application/json", "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const t = await res.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t.slice(0, 300); }
  return { status: res.status, ok: res.ok, body };
}

const patchRow = (id: string, patch: Record<string, unknown>) =>
  fetch(SUPABASE_URL + "/rest/v1/ghl_outbound?id=eq." + id,
        { method: "PATCH", headers: svc, body: JSON.stringify(patch) });

const STATUSES = ["open", "won", "lost", "abandoned"];

/** Set only the opportunity's status. Read, skip-if-same, write, confirm. */
async function writeStatus(row: any, dry: boolean) {
  const want = String(row.set_status || "").toLowerCase();
  if (!STATUSES.includes(want)) {
    await patchRow(row.id, { status: "failed", attempts: row.attempts + 1,
      last_error: "status-only row with no valid set_status (" + row.set_status + ")" });
    return { id: row.id, outcome: "failed", reason: "bad status" };
  }

  const cur = await ghl("/opportunities/" + row.opportunity_id);
  if (!cur.ok || !cur.body?.opportunity) {
    const attempts = row.attempts + 1;
    await patchRow(row.id, { status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      attempts, last_error: "read failed: HTTP " + cur.status });
    return { id: row.id, outcome: "retry", status: cur.status };
  }
  const opp = cur.body.opportunity;
  const had = String(opp.status || "").toLowerCase();

  if (had === want) {
    await patchRow(row.id, { status: "skipped", attempts: row.attempts + 1,
      sent_at: new Date().toISOString(), last_error: null, note: "already " + want });
    return { id: row.id, outcome: "already-there", name: opp.name, status: want };
  }
  if (dry) return { id: row.id, outcome: "would-set-status", name: opp.name, from: had, to: want };

  const payload: Record<string, unknown> = { status: want };
  // Sent back explicitly so a status change can never blank the card's owner.
  if (opp.assignedTo) payload.assignedTo = opp.assignedTo;
  const put = await ghl("/opportunities/" + row.opportunity_id, { method: "PUT", body: JSON.stringify(payload) });
  if (!put.ok) {
    const attempts = row.attempts + 1;
    await patchRow(row.id, { status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      attempts, last_error: "HTTP " + put.status + " " + JSON.stringify(put.body).slice(0, 200) });
    return { id: row.id, outcome: "retry", status: put.status, body: put.body };
  }

  // CONFIRM. A 200 is not proof the status changed.
  await sleep(1200);
  const after = await ghl("/opportunities/" + row.opportunity_id);
  const now = String(after.body?.opportunity?.status || "").toLowerCase();
  if (now === want) {
    await patchRow(row.id, { status: "sent", attempts: row.attempts + 1,
      sent_at: new Date().toISOString(), last_error: null,
      note: "status " + (had || "(none)") + " -> " + want + " (confirmed)" });
    return { id: row.id, outcome: "status-set", name: opp.name, from: had, to: want };
  }
  const attempts = row.attempts + 1;
  await patchRow(row.id, { status: attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts,
    last_error: "GHL accepted the write (HTTP 200) but the status is " +
      (after.ok ? (now || "(none)") : "(re-read failed: HTTP " + after.status + ")") + ", not " + want +
      ". Something is reverting it — check for a GHL workflow on opportunity status." });
  return { id: row.id, outcome: "not-applied", name: opp.name, expected: want, actual: now };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : url.searchParams.get("token");
  if (!token) return json(401, { error: "missing token" });

  // Retried: a cold start can lose the credential fetch, and a transient null
  // must not read as a bad token.
  let hash: string | null = null;
  for (let i = 0; i < 3 && !hash; i++) {
    const c = await fetch(SUPABASE_URL + "/rest/v1/webhook_credentials?id=eq.ghl_admin&select=secret_hash",
      { headers: svc }).then((r) => r.json()).catch(() => null);
    hash = c?.[0]?.secret_hash || null;
    if (!hash) await sleep(300);
  }
  if (!hash) return json(503, { error: "could not read credentials" });
  if (!safeEq(await sha256Hex(token), hash)) return json(401, { error: "bad token" });

  const dry = url.searchParams.get("dry") === "1";

  const pending: any[] = await fetch(
    SUPABASE_URL + "/rest/v1/ghl_outbound?status=eq.pending&attempts=lt." + MAX_ATTEMPTS +
    "&select=id,job_id,opportunity_id,target_stage_name,set_status,attempts&order=created_at.asc&limit=50",
    { headers: svc }).then((r) => r.json()).catch(() => []);

  if (!pending.length) return json(200, { drained: 0, note: "nothing pending" });

  const results: any[] = [];

  // Status-only rows first: they do not need the pipeline at all.
  for (const row of pending.filter((r) => !r.target_stage_name)) {
    results.push(await writeStatus(row, dry));
    await sleep(150);
  }
  const stageRows = pending.filter((r) => r.target_stage_name);
  if (!stageRows.length) return json(200, { drained: pending.length, dryRun: dry, results });

  const pipes = await ghl("/opportunities/pipelines?locationId=" + LOCATION);
  const prod = (pipes.body?.pipelines || []).find((p: any) => p.id === PIPELINE);
  if (!prod) return json(200, { error: "could not read the Production pipeline", status: pipes.status, results });
  const stageId = new Map<string, string>((prod.stages || []).map((s: any) => [norm(s.name), s.id]));
  const stageNameById = new Map<string, string>((prod.stages || []).map((s: any) => [s.id, s.name]));

  for (const row of stageRows) {
    const target = stageId.get(norm(row.target_stage_name));
    if (!target) {
      await patchRow(row.id, { status: "failed", attempts: row.attempts + 1,
        last_error: "no stage named " + row.target_stage_name + " in the Production pipeline" });
      results.push({ id: row.id, outcome: "failed", reason: "unknown stage" });
      continue;
    }

    const cur = await ghl("/opportunities/" + row.opportunity_id);
    if (!cur.ok || !cur.body?.opportunity) {
      const attempts = row.attempts + 1;
      await patchRow(row.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts, last_error: "read failed: HTTP " + cur.status });
      results.push({ id: row.id, outcome: "retry", status: cur.status });
      continue;
    }
    const opp = cur.body.opportunity;
    const fromName = stageNameById.get(opp.pipelineStageId) || opp.pipelineStageId;

    if (opp.pipelineStageId === target) {
      await patchRow(row.id, { status: "skipped", attempts: row.attempts + 1,
        sent_at: new Date().toISOString(), last_error: null,
        note: "already in " + row.target_stage_name });
      // Bring substage back in step so the board stops disagreeing with the CRM.
      await fetch(SUPABASE_URL + "/rest/v1/jobs?id=eq." + row.job_id,
        { method: "PATCH", headers: svc, body: JSON.stringify({ substage: row.target_stage_name }) });
      results.push({ id: row.id, outcome: "already-there", name: opp.name });
      continue;
    }

    if (dry) {
      results.push({ id: row.id, outcome: "would-move", name: opp.name,
        from: fromName, to: row.target_stage_name });
      continue;
    }

    const payload: Record<string, unknown> = { pipelineId: PIPELINE, pipelineStageId: target };
    if (row.set_status) payload.status = row.set_status;
    // Sent back explicitly so a stage move can never blank the card's owner.
    if (opp.assignedTo) payload.assignedTo = opp.assignedTo;

    const put = await ghl("/opportunities/" + row.opportunity_id,
                          { method: "PUT", body: JSON.stringify(payload) });

    if (!put.ok) {
      const attempts = row.attempts + 1;
      await patchRow(row.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts, last_error: "HTTP " + put.status + " " + JSON.stringify(put.body).slice(0, 200) });
      results.push({ id: row.id, outcome: "retry", status: put.status, body: put.body });
      await sleep(150);
      continue;
    }

    // CONFIRM. A 200 is not proof the stage changed.
    await sleep(1200);
    const after = await ghl("/opportunities/" + row.opportunity_id);
    const nowStage = after.body?.opportunity?.pipelineStageId;

    if (nowStage === target) {
      await patchRow(row.id, { status: "sent", attempts: row.attempts + 1,
        sent_at: new Date().toISOString(), last_error: null,
        note: "moved from " + fromName + " to " + row.target_stage_name + " (confirmed)" });
      await fetch(SUPABASE_URL + "/rest/v1/jobs?id=eq." + row.job_id,
        { method: "PATCH", headers: svc, body: JSON.stringify({ substage: row.target_stage_name }) });
      results.push({ id: row.id, outcome: "moved", name: opp.name,
        from: fromName, to: row.target_stage_name });
    } else {
      const landed = after.ok
        ? (stageNameById.get(nowStage) || nowStage || "(unknown)")
        : "(re-read failed: HTTP " + after.status + ")";
      const attempts = row.attempts + 1;
      await patchRow(row.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        last_error: "GHL accepted the write (HTTP 200) but the card is in " + landed +
                    ", not " + row.target_stage_name +
                    ". Something is reverting it — check for a GHL workflow on this stage." });
      results.push({ id: row.id, outcome: "not-applied", name: opp.name,
        expected: row.target_stage_name, actual: landed });
    }

    await sleep(150);
  }

  return json(200, { drained: pending.length, dryRun: dry, results });
});
