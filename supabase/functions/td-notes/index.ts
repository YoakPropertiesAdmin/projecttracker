import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { db, DEFAULT_LOCATION, ghlFetch, logSync } from "../_shared/crm-client.ts";

/**
 * Job notes (2026-11-25). GHL owns notes: they live on the GHL contact's Notes
 * tab, and TradeDesk shows them as a dated log on the job card (public.job_notes
 * over the contact_notes mirror). See the 20261125150000_job_notes_from_ghl migration.
 *
 * Only contacts on a monitored-pipeline job are mirrored (a TradeDesk job with a
 * GHL opportunity; jobs only come from the Production pipeline). Everything
 * else in GHL is ignored. Jobs with no such contact keep TradeDesk-only notes.
 *
 * Signed-in users (Supabase session token, and the job must be one they can see):
 *   POST { action: "list", job_id }        re-read the contact's notes from GHL, return the log
 *   POST { action: "add",  job_id, body }  write a note to the GHL contact (or keep it
 *                                          in TradeDesk when the job has no contact)
 * Admin credential (ghl_admin, same as td-crm-admin):
 *   POST { action: "probe" }                         can the app create contact notes?
 *   POST { action: "seed", offset?, limit? }         one-time pull of every monitored contact's notes
 *   POST { action: "migrate_apply", limit? }         carry out the planned note_migration rows
 * No schedule calls this. GHL is written only by "add" and by an approved migrate_apply.
 *
 * Writing (v2, 2026-11-25): the app cannot get contacts.write, so notes are created
 * with the Notes API (POST /notes/, Version v3, scope notes.write) attached to the
 * contact through relations [{ objectKey: "contact" }]. That API requires a GHL
 * userId: the writer's linked GHL user, else the GHL user with the same email,
 * else GHL_NOTES_FALLBACK_USER_ID (Joshua Egan) with the note signed by the writer.
 * Reading still uses GET /contacts/:id/notes (contacts.readonly).
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://www.renewhomeext.com,https://renewhomeext.com,https://renewprojecttracker.netlify.app,http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 5000;
const MIGRATED_ON = "11/25/2026";
const FALLBACK_GHL_USER = (Deno.env.get("GHL_NOTES_FALLBACK_USER_ID") || "IMVODLnWE1xJBob2r4tK").trim();

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Vary": "Origin",
  };
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const jobNo = (n: number | string) => "JOB-" + String(n).padStart(4, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Job = { id: string; number: number; ghl_contact_id: string | null; ghl_opportunity_id: string | null; created_at: string; notes: string | null };
const monitored = (j: Job) => Boolean(j.ghl_contact_id && j.ghl_opportunity_id);

async function loadJob(id: string): Promise<Job | null> {
  const { data } = await db().from("jobs")
    .select("id,number,ghl_contact_id,ghl_opportunity_id,created_at,notes").eq("id", id).maybeSingle();
  return (data as Job) || null;
}

/** GHL note -> the shape contact_notes_upsert reads. */
const asNote = (n: any, contactId: string) => ({
  id: n.id, contactId: n.contactId || contactId, body: n.body ?? n.bodyText ?? "",
  userId: n.userId || null, dateAdded: n.dateAdded || null,
});

/** Read a contact's notes from GHL into the mirror. Returns false when GHL could not be read. */
async function pullContact(contactId: string): Promise<{ ok: boolean; status: number; result?: unknown }> {
  const r = await ghlFetch("/contacts/" + encodeURIComponent(contactId) + "/notes");
  if (!r.ok) return { ok: false, status: r.status };
  const notes = (r.body?.notes || []).map((n: any) => asNote(n, contactId));
  const { data, error } = await db().rpc("contact_notes_upsert", { p_notes: notes, p_full_contact: contactId });
  if (error) return { ok: false, status: 500, result: error.message };
  return { ok: true, status: r.status, result: data };
}

async function jobLog(jobId: string) {
  const { data, error } = await db().rpc("job_notes", { p_job: jobId });
  if (error) throw new Error(error.message);
  return data || [];
}

/** Who is writing: their GHL user (when the login is linked) and a display name. */
async function author(userId: string, email: string | null) {
  const { data: link } = await db().from("ghl_user_links").select("ghl_user_id").eq("user_id", userId).maybeSingle();
  let ghlUserId: string | null = link?.ghl_user_id || null;
  let name: string | null = null;
  if (ghlUserId) {
    const { data: gu } = await db().from("ghl_users").select("name,deleted").eq("ghl_user_id", ghlUserId).maybeSingle();
    if (gu?.deleted) ghlUserId = null;
    name = gu?.name || null;
  }
  if (!ghlUserId && email) {
    const { data: byEmail } = await db().from("ghl_users").select("ghl_user_id,name")
      .ilike("email", email).eq("deleted", false).limit(1).maybeSingle();
    if (byEmail?.ghl_user_id) { ghlUserId = byEmail.ghl_user_id; name = name || byEmail.name || null; }
  }
  if (!name) {
    const { data: a } = await db().from("assignees").select("name").eq("user_id", userId).limit(1).maybeSingle();
    name = a?.name || null;
  }
  return { ghlUserId, name: name || (email ? email.split("@")[0] : "TradeDesk user") };
}

/** Create a note on a GHL contact (Notes API, notes.write). */
async function createGhlNote(contactId: string, body: string, ghlUserId: string | null) {
  const payload = { body, userId: ghlUserId || FALLBACK_GHL_USER,
                    relations: [{ objectKey: "contact", recordId: contactId }] };
  return await ghlFetch("/notes/?locationId=" + encodeURIComponent(DEFAULT_LOCATION),
    { method: "POST", headers: { Version: "v3" }, body: JSON.stringify(payload) });
}

// ---------------- user actions ----------------
async function userAction(body: any, user: { id: string; email: string | null }, token: string) {
  const jobId = String(body?.job_id || "");
  if (!jobId) return [400, { error: "job_id required" }] as const;
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: can, error: canErr } = await asUser.rpc("can_see_job", { p_job: jobId });
  if (canErr || !can) return [403, { error: "you can't see that job" }] as const;
  const job = await loadJob(jobId);
  if (!job) return [404, { error: "job not found" }] as const;

  if (body.action === "list") {
    let stale = false;
    if (monitored(job)) {
      const p = await pullContact(job.ghl_contact_id!);
      stale = !p.ok;
    }
    return [200, { notes: await jobLog(jobId), stale, in_ghl: monitored(job) }] as const;
  }

  if (body.action === "add") {
    const text = String(body.body || "").replace(/\r\n/g, "\n").trim();
    if (!text) return [400, { error: "the note is empty" }] as const;
    if (text.length > MAX_BODY) return [400, { error: "notes are limited to " + MAX_BODY + " characters" }] as const;
    const who = await author(user.id, user.email);

    if (!monitored(job)) {
      const { error } = await db().from("contact_notes").insert({
        job_id: job.id, body: text, author_name: who.name, created_by: user.id, source: "local" });
      if (error) return [500, { error: error.message }] as const;
      return [200, { notes: await jobLog(jobId), stale: false, in_ghl: false }] as const;
    }

    // In GHL the note carries the job number (a contact can have several jobs)
    // and, when the login isn't linked to a GHL user, who wrote it.
    const ghlBody = jobNo(job.number) + ": " + text + (who.ghlUserId ? "" : "\n\n— " + who.name + " (via TradeDesk)");
    const r = await createGhlNote(job.ghl_contact_id!, ghlBody, who.ghlUserId);
    const note = r.body?.note || r.body;
    if (!r.ok || !note?.id) {
      await logSync({ direction: "out", entity: "contact", action: "note_create_failed", ok: false,
                      ghl_id: job.ghl_contact_id, job_id: job.id, source: "td-notes",
                      detail: { status: r.status, body: r.body } });
      const scope = r.status === 401 || r.status === 403;
      return [502, { error: scope
        ? "GHL refused the note (the TradeDesk app isn't allowed to write contact notes yet). Nothing was saved."
        : "GHL didn't take the note (HTTP " + r.status + "). Nothing was saved — try again." }] as const;
    }
    const { error } = await db().rpc("contact_notes_upsert", {
      p_notes: [asNote(note, job.ghl_contact_id!)], p_source: "tradedesk", p_job: job.id,
      p_created_by: user.id, p_author: who.name });
    if (error) return [500, { error: "saved in GHL but not shown here yet: " + error.message }] as const;
    await logSync({ direction: "out", entity: "contact", action: "note_created", ok: true,
                    ghl_id: job.ghl_contact_id, job_id: job.id, source: "td-notes", detail: { note_id: note.id } });
    return [200, { notes: await jobLog(jobId), stale: false, in_ghl: true }] as const;
  }

  return [400, { error: "unknown action" }] as const;
}

// ---------------- admin actions ----------------
async function seed(offset: number, limit: number) {
  const { data } = await db().from("jobs").select("ghl_contact_id")
    .not("ghl_contact_id", "is", null).not("ghl_opportunity_id", "is", null);
  const contacts = [...new Set((data || []).map((r: any) => r.ghl_contact_id as string))].sort()
    .slice(offset, offset + limit);
  let ok = 0; const failed: unknown[] = []; let notes = 0;
  for (const c of contacts) {
    const p = await pullContact(c);
    if (p.ok) { ok++; notes += Number((p.result as any)?.upserted || 0); }
    else failed.push({ contact: c, status: p.status, detail: p.result ?? null });
    await sleep(120);
  }
  await logSync({ direction: "in", entity: "contact", action: "notes_seed", ok: failed.length === 0,
                  source: "td-notes", detail: { offset, limit, contacts: contacts.length, ok, notes, failed } });
}

async function migrateApply(limit: number) {
  const { data: rows } = await db().from("note_migration").select("*")
    .eq("status", "planned").order("job_number").limit(limit);
  let done = 0, failed = 0;
  for (const m of rows || []) {
    const job = await loadJob(m.job_id);
    const fail = async (error: string) => {
      failed++;
      await db().from("note_migration").update({ status: "failed", error, applied_at: new Date().toISOString() }).eq("job_id", m.job_id);
    };
    if (!job) { await fail("job not found"); continue; }
    try {
      if (m.action === "already_in_ghl") {
        const { data: n } = await db().from("contact_notes").select("id").eq("ghl_note_id", m.matched_note_id).maybeSingle();
        await db().from("note_migration").update({ status: "done", contact_note_id: n?.id ?? null,
          applied_at: new Date().toISOString(), error: null }).eq("job_id", m.job_id);
      } else if (m.action === "local") {
        const { data: n, error } = await db().from("contact_notes").insert({
          job_id: job.id, body: m.legacy_body, author_name: "TradeDesk (before " + MIGRATED_ON + ")",
          date_added: job.created_at, source: "migration" }).select("id").single();
        if (error) { await fail(error.message); continue; }
        await db().from("note_migration").update({ status: "done", contact_note_id: n.id,
          applied_at: new Date().toISOString(), error: null }).eq("job_id", m.job_id);
      } else {
        if (!monitored(job) || job.ghl_contact_id !== m.contact_id) { await fail("job's GHL contact changed since planning; re-plan"); continue; }
        const body = jobNo(job.number) + " · Notes moved from TradeDesk " + MIGRATED_ON + "\n\n" + m.legacy_body;
        const r = await createGhlNote(job.ghl_contact_id!, body, null);
        const note = r.body?.note || r.body;
        if (!r.ok || !note?.id) { await fail("GHL HTTP " + r.status + ": " + JSON.stringify(r.body).slice(0, 300)); continue; }
        const { error } = await db().rpc("contact_notes_upsert", {
          p_notes: [asNote(note, job.ghl_contact_id!)], p_source: "migration", p_job: job.id,
          p_author: "TradeDesk (before " + MIGRATED_ON + ")" });
        if (error) { await fail("created in GHL (" + note.id + ") but mirror failed: " + error.message); continue; }
        const { data: n } = await db().from("contact_notes").select("id").eq("ghl_note_id", note.id).maybeSingle();
        await db().from("note_migration").update({ status: "done", contact_note_id: n?.id ?? null,
          applied_at: new Date().toISOString(), error: null }).eq("job_id", m.job_id);
        await sleep(150);
      }
      done++;
    } catch (e) { await fail(String(e)); }
  }
  await logSync({ direction: "out", entity: "contact", action: "notes_migrate_apply", ok: failed === 0,
                  source: "td-notes", detail: { limit, done, failed } });
}

Deno.serve(async (req: Request) => {
  const h = cors(req);
  const json = (s: number, b: unknown) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...h, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json(401, { error: "sign in first" });
  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "body must be JSON" }); }

  // Admin credential?
  const { data: cred } = await db().from("webhook_credentials").select("secret_hash").eq("id", "ghl_admin").maybeSingle();
  const isAdminCred = Boolean(cred?.secret_hash) && safeEq(await sha256Hex(token), cred!.secret_hash);

  if (isAdminCred) {
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    const bg = (p: Promise<unknown>) => { if (rt?.waitUntil) rt.waitUntil(p); return p; };
    if (body?.action === "probe") {
      // A contact id that cannot exist: tells a missing scope (401/403) from "no such contact".
      const r = await createGhlNote("tdProbeNoSuchContact000", "probe", null);
      return json(200, { status: r.status, body: r.body });
    }
    if (body?.action === "seed") {
      const offset = Math.max(0, Number(body.offset) || 0), limit = Math.min(300, Math.max(1, Number(body.limit) || 300));
      bg(seed(offset, limit).catch((e) => logSync({ direction: "in", entity: "contact", action: "notes_seed", ok: false,
        source: "td-notes", detail: { error: String(e) } })));
      return json(202, { accepted: true, offset, limit });
    }
    if (body?.action === "migrate_apply") {
      const limit = Math.min(300, Math.max(1, Number(body.limit) || 300));
      bg(migrateApply(limit).catch((e) => logSync({ direction: "out", entity: "contact", action: "notes_migrate_apply",
        ok: false, source: "td-notes", detail: { error: String(e) } })));
      return json(202, { accepted: true, limit });
    }
    return json(400, { error: "unknown admin action" });
  }

  const { data: u, error: uErr } = await db().auth.getUser(token);
  if (uErr || !u?.user) return json(401, { error: "your session has expired — reload TradeDesk" });
  try {
    const [status, out] = await userAction(body, { id: u.user.id, email: u.user.email ?? null }, token);
    return json(status, out);
  } catch (e) {
    return json(500, { error: String(e) });
  }
});
