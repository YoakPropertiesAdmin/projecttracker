import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Drains public.email_outbound and sends through Resend.
 *
 * Purposes:
 *   gp_finalized  one job's final gross profit (row written by finalize_job_gp)
 *   sync_flags    morning digest (row written by job_flags_digest(); content in payload):
 *                 contracts with no TradeDesk job, jobs missing a Project ID (project_id_missing),
 *                 and GHL Job/Project records that differ from TradeDesk (ghl_drift / ghl_missing / ghl_extra)
 *   health_alert  health monitor (row written by health_run_checks(); content in payload):
 *                 newly opened findings and findings that cleared since the last alert
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = (Deno.env.get("RESEND_API_KEY") || "").trim();

const MAX_ATTEMPTS = 5;
const BATCH = 10;

const svc = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "content-type": "application/json" };
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

const rest = (path: string, init?: RequestInit) =>
  fetch(SUPABASE_URL + "/rest/v1/" + path, { ...init, headers: { ...svc, ...(init?.headers || {}) } });

const money = (n: unknown) => {
  const v = Number(n || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (n: unknown) => (Number(n || 0) * 100).toFixed(1) + "%";
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(job: any, f: any, revised: boolean, threshold: number | null) {
  const ref = job.ghl_project_display_id ? "#" + job.ghl_project_display_id : "JOB-" + job.number;
  const who = job.customer_name || "(no name)";
  const subject = (revised ? "REVISED — " : "") + "Final GP " + money(f.margin) + " — " + ref + " " + who;

  const delta = f.prior_margin !== null && f.prior_margin !== undefined
    ? Number(f.margin) - Number(f.prior_margin) : null;
  const thin = threshold === null || threshold === undefined
    ? false : Number(f.margin_pct || 0) < Number(threshold);
  const mark = threshold ? Math.round(Number(threshold) * 100) + "%" : "";

  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:7px 14px 7px 0;color:#6E675C;font-size:14px;">${esc(label)}</td>` +
    `<td style="padding:7px 0;font-size:14px;text-align:right;${strong ? "font-weight:700;" : ""}">${esc(value)}</td></tr>`;

  const changeBlock = delta === null ? "" :
    `<p style="margin:0 0 18px;padding:11px 14px;border-radius:7px;` +
    `background:${delta >= 0 ? "#E9F1EC" : "#FDF3E3"};color:${delta >= 0 ? "#2F6B46" : "#8A5A12"};` +
    `font-size:14px;line-height:1.5;">` +
    (revised
      ? `This job was finalized before and an email went out then. `
      : `This job was finalized before, but was healthy enough then that nothing was sent. `) +
    `Gross profit was <strong>${esc(money(f.prior_margin))}</strong> and is now ` +
    `<strong>${esc(money(f.margin))}</strong> — a change of <strong>${esc((delta >= 0 ? "+" : "") + money(delta))}</strong>, ` +
    `normally a vendor bill or vendor credit that arrived after the first finalization.</p>`;

  const why = thin
    ? `You are seeing this because the gross profit came in under ${esc(mark)}.`
    : `You are seeing this because the gross profit on this job changed after it was finalized.`;

  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F2EC;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3A352E;">` +
    `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:11px;padding:26px 28px;">` +
    `<div style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#8A8478;">` +
    `${revised ? "Revised final gross profit" : "Final gross profit"}</div>` +
    `<h1 style="margin:4px 0 2px;font-size:21px;">${esc(who)}</h1>` +
    `<div style="color:#6E675C;font-size:14px;margin-bottom:20px;">${esc(ref)}` +
    (job.customer_address ? " · " + esc(job.customer_address) : "") + `</div>` +
    changeBlock +
    `<div style="font-size:31px;font-weight:700;margin-bottom:2px;` +
    `color:${Number(f.margin) < 0 ? "#9B3A20" : "#2F6B46"};">${esc(money(f.margin))}</div>` +
    `<div style="color:#6E675C;font-size:14px;margin-bottom:22px;">${esc(pct(f.margin_pct))} of contract` +
    (thin ? ` — under the ${esc(mark)} mark` : ``) + `</div>` +
    `<table style="width:100%;border-collapse:collapse;border-top:1px solid #EBE6DC;">` +
    row("Contract amount", money(f.contract_amount)) +
    row("Client received", money(f.client_received)) +
    row("Vendor costs paid", money(f.vendor_paid)) +
    row("Vendor costs pending", money(f.vendor_pending)) +
    (Number(f.vendor_credits || 0) > 0 ? row("Vendor credits", money(-Number(f.vendor_credits))) : "") +
    row("Total costs", money(f.vendor_total)) +
    row("Gross profit", money(f.margin) + "  (" + pct(f.margin_pct) + ")", true) +
    `</table>` +
    `<p style="margin:22px 0 0;color:#8A8478;font-size:12px;line-height:1.6;">` +
    `Finalized in TradeDesk on ${esc(new Date(f.finalized_at).toLocaleString("en-US", { timeZone: "America/New_York" }))} ET. ` +
    `These figures are the snapshot taken at that moment; later costs do not change them. ` +
    `${why}</p>` +
    `</div></body></html>`;

  const text = [
    (revised ? "REVISED — " : "") + "Final gross profit",
    who + "  " + ref,
    job.customer_address || "",
    "",
    delta === null ? "" : "Previously " + money(f.prior_margin) + ", now " + money(f.margin) +
      " (" + (delta >= 0 ? "+" : "") + money(delta) + ")",
    "",
    "Contract amount      " + money(f.contract_amount),
    "Client received      " + money(f.client_received),
    "Vendor costs paid    " + money(f.vendor_paid),
    "Vendor costs pending " + money(f.vendor_pending),
    Number(f.vendor_credits || 0) > 0 ? "Vendor credits       " + money(-Number(f.vendor_credits)) : "",
    "Total costs          " + money(f.vendor_total),
    "Gross profit         " + money(f.margin) + "  (" + pct(f.margin_pct) + ")",
    "",
    why.replace(/<[^>]+>/g, ""),
  ].filter((l) => l !== "").join("\n");

  return { subject, html, text };
}

const SOURCE: Record<string, string> = {
  ghl_sweep: "GHL nightly check", ghl_webhook: "GHL webhook", ghl_workflow: "Old GHL workflow", sales_sheet: "Sales sheet",
  ghl_check: "GHL Jobs/Projects check", tradedesk: "TradeDesk",
};
const CHECK_KINDS = new Set(["ghl_drift", "ghl_missing", "ghl_extra"]);
const JOB_KINDS = new Set(["project_id_missing"]);
const CHECK_TITLE: Record<string, string> = {
  ghl_drift: "GHL differs from TradeDesk", ghl_missing: "Missing in GHL", ghl_extra: "Extra record in GHL",
};
const VIA: Record<string, string> = { manual: "entered in TradeDesk", webhook: "created from GHL", system: "created by the system" };

/** Morning digest: contracts with no job, jobs missing a Project ID, then GHL Job/Project differences. */
function renderFlags(payload: any) {
  const all: any[] = Array.isArray(payload?.flags) ? payload.flags : [];
  const contracts = all.filter((f) => !CHECK_KINDS.has(f.kind) && !JOB_KINDS.has(f.kind));
  const jobs = all.filter((f) => JOB_KINDS.has(f.kind));
  const checks = all.filter((f) => CHECK_KINDS.has(f.kind));
  const parts = [];
  if (contracts.length) parts.push(`${contracts.length} contract${contracts.length === 1 ? "" : "s"} with no job`);
  if (jobs.length) parts.push(`${jobs.length} job${jobs.length === 1 ? "" : "s"} missing a Project ID`);
  if (checks.length) parts.push(`${checks.length} GHL record${checks.length === 1 ? "" : "s"} to check`);
  const subject = "TradeDesk: " + (parts.join(", ") || "nothing to review");

  const cand = (f: any) => {
    const c: any[] = Array.isArray(f.candidates) ? f.candidates : [];
    if (!c.length) return "No likely match in TradeDesk.";
    return "Possible match: " + c.slice(0, 3).map((x) =>
      `JOB-${x.number} ${x.name} ${money(x.amount)}${x.name_match && x.amount_match ? " (name and amount match)" : x.name_match ? " (name matches)" : ""}`).join("; ");
  };
  const where = (f: any) => {
    const d = f.detail || {};
    if (f.kind === "sheet_no_job") return `Sales tab row ${d.sheet_row ?? "?"}, sold ${d.sales_date ?? "?"}${d.product ? ", " + d.product : ""}`;
    return `GHL opportunity ${f.ref}${d.stage ? ", stage " + d.stage : ""}${d.display_id ? ", project #" + d.display_id : ""}`;
  };
  const since = (f: any) => new Date(f.first_seen_at).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const jobLine = (f: any) => {
    const d = f.detail || {};
    return [d.type_label || d.job_type, d.stage ? "stage " + d.stage : "", VIA[d.created_via] || ""].filter(Boolean).join(" · ");
  };
  const cell = (inner: string) =>
    `<tr><td style="padding:12px 0;border-top:1px solid #EBE6DC;font-size:14px;line-height:1.5;">${inner}</td></tr>`;

  const contractRows = contracts.map((f) => cell(
    `<strong>${esc(f.name || "(no name)")}</strong> — ${esc(money(f.amount))}<br>` +
    `<span style="color:#6E675C;">${esc(SOURCE[f.source] || f.source)} · ${esc(where(f))} · first seen ${esc(since(f))}</span><br>` +
    `<span style="color:#6E675C;">${esc(cand(f))}</span>` +
    (f.detail?.reason ? `<br><span style="color:#8A8478;font-size:12px;">${esc(f.detail.reason)}</span>` : ""))).join("");
  const jobRows = jobs.map((f) => cell(
    `<strong>${esc(f.name || "(no name)")}</strong><br>` +
    `<span style="color:#6E675C;">${esc(jobLine(f))}</span><br>` +
    `<span style="color:#8A8478;font-size:12px;">first seen ${esc(since(f))}</span>`)).join("");
  const checkRows = checks.map((f) => cell(
    `<strong>${esc(f.name || "(no name)")}</strong> — ${esc(CHECK_TITLE[f.kind] || f.kind)}<br>` +
    `<span style="color:#6E675C;">${esc(f.detail?.summary || "")}</span><br>` +
    `<span style="color:#8A8478;font-size:12px;">first seen ${esc(since(f))}</span>`)).join("");

  const section = (title: string, note: string, rows: string) => !rows ? "" :
    `<h2 style="margin:22px 0 4px;font-size:16px;">${esc(title)}</h2>` +
    `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#6E675C;">${esc(note)}</p>` +
    `<table style="width:100%;border-collapse:collapse;">${rows}</table>`;

  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F2EC;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3A352E;">` +
    `<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:11px;padding:26px 28px;">` +
    `<div style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#8A8478;">TradeDesk morning check</div>` +
    `<h1 style="margin:4px 0 6px;font-size:21px;">${esc(all.length)} to review</h1>` +
    section("Contracts with no TradeDesk job",
      "Nothing creates these automatically. Link each one to its job, or create the job in TradeDesk.", contractRows) +
    section("Jobs missing a Project ID",
      "Rehab jobs need their GHL project # so GHL can match them instead of creating a second job. Add it on the job in TradeDesk.", jobRows) +
    section("GHL Jobs / Projects that differ from TradeDesk",
      "The check only reports; nothing was changed. A normal TradeDesk edit pushes the fix, or ask Claude to resync the record.", checkRows) +
    `<p style="margin:20px 0 0;color:#8A8478;font-size:12px;">Each item drops off once it matches.</p>` +
    `</div></body></html>`;
  const text = [subject, ""]
    .concat(contracts.map((f) => `- ${f.name || "(no name)"} ${money(f.amount)} | ${SOURCE[f.source] || f.source} | ${where(f)} | ${cand(f)}`))
    .concat(jobs.map((f) => `- ${f.name || "(no name)"} | missing Project ID | ${jobLine(f)}`))
    .concat(checks.map((f) => `- ${f.name || "(no name)"} | ${CHECK_TITLE[f.kind] || f.kind} | ${f.detail?.summary || ""}`)).join("\n");
  return { subject, html, text };
}

/** Health monitor alert: findings that opened, then findings that cleared. */
function renderHealth(payload: any) {
  const opened: any[] = Array.isArray(payload?.opened) ? payload.opened : [];
  const resolved: any[] = Array.isArray(payload?.resolved) ? payload.resolved : [];
  const errors = opened.filter((f) => f.severity === "error").length;
  const subject = opened.length
    ? `TradeDesk health: ${opened.length} new problem${opened.length === 1 ? "" : "s"}` +
      (errors ? ` (${errors} serious)` : "") + (resolved.length ? `, ${resolved.length} cleared` : "")
    : `TradeDesk health: ${resolved.length} problem${resolved.length === 1 ? "" : "s"} cleared`;

  const when = (t: unknown) => t
    ? new Date(String(t)).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET"
    : "";
  const badge = (sev: string) => {
    const s = sev === "error" ? ["#FBE9E4", "#9B3A20", "Serious"] : sev === "warn" ? ["#FDF3E3", "#8A5A12", "Warning"] : ["#EEF1F5", "#4A5A70", "Info"];
    return `<span style="display:inline-block;padding:1px 7px;border-radius:9px;background:${s[0]};color:${s[1]};font-size:11px;font-weight:600;">${s[2]}</span>`;
  };
  const detailText = (d: any) => {
    if (!d || typeof d !== "object") return "";
    return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => k.replace(/_/g, " ") + ": " + (typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join(" · ").slice(0, 600);
  };
  const cell = (inner: string) =>
    `<tr><td style="padding:12px 0;border-top:1px solid #EBE6DC;font-size:14px;line-height:1.5;">${inner}</td></tr>`;

  const openRows = opened.map((f) => cell(
    `${badge(f.severity)} <strong>${esc(f.title)}</strong><br>` +
    (f.description ? `<span style="color:#6E675C;">${esc(f.description)}</span><br>` : "") +
    (detailText(f.detail) ? `<span style="color:#8A8478;font-size:12px;">${esc(detailText(f.detail))}</span><br>` : "") +
    `<span style="color:#8A8478;font-size:12px;">${esc(f.label)} · seen ${esc(when(f.first_seen))}</span>`)).join("");
  const fixedRows = resolved.map((f) => cell(
    `<strong>${esc(f.title)}</strong><br>` +
    `<span style="color:#8A8478;font-size:12px;">${esc(f.label)} · opened ${esc(when(f.first_seen))}, cleared ${esc(when(f.resolved_at))}</span>`)).join("");

  const section = (title: string, rows: string) => !rows ? "" :
    `<h2 style="margin:22px 0 4px;font-size:16px;">${esc(title)}</h2>` +
    `<table style="width:100%;border-collapse:collapse;">${rows}</table>`;

  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F2EC;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3A352E;">` +
    `<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:11px;padding:26px 28px;">` +
    `<div style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#8A8478;">TradeDesk health monitor</div>` +
    `<h1 style="margin:4px 0 6px;font-size:21px;">${esc(subject.replace(/^TradeDesk health: /, ""))}</h1>` +
    `<p style="margin:0;font-size:13px;color:#6E675C;">${esc(payload?.open_total ?? 0)} problem(s) open in total.</p>` +
    section("New", openRows) +
    section("Cleared", fixedRows) +
    `<p style="margin:20px 0 0;color:#8A8478;font-size:12px;line-height:1.6;">` +
    `The monitor runs every 15 minutes and only reports; it changed nothing. ` +
    `Each problem is emailed once when it opens and once when it clears. ` +
    `Details are in the health_findings table.</p>` +
    `</div></body></html>`;
  const text = [subject, ""]
    .concat(opened.map((f) => `NEW [${f.severity}] ${f.title} | ${detailText(f.detail)}`))
    .concat(resolved.map((f) => `CLEARED ${f.title}`)).join("\n");
  return { subject, html, text };
}

async function send(from: string, to: string[], subject: string, html: string, text: string) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_KEY, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && Boolean(body?.id);
    return { ok, providerId: body?.id || null, err: ok ? null : "resend " + res.status + ": " + JSON.stringify(body).slice(0, 300) };
  } catch (e) {
    return { ok: false, providerId: null, err: String(e).slice(0, 300) };
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : url.searchParams.get("token");
  if (!token) return json(401, { error: "missing token" });
  const cred = await rest("webhook_credentials?id=eq.email_admin&select=secret_hash")
    .then((r) => r.json()).catch(() => null);
  if (!cred?.[0]?.secret_hash || !safeEq(await sha256Hex(token), cred[0].secret_hash)) {
    return json(401, { error: "bad token" });
  }
  if (!RESEND_KEY) return json(500, { error: "RESEND_API_KEY is not set on this function" });

  const dry = url.searchParams.get("dry") === "1";

  const queued: any[] = await rest(
    "email_outbound?status=eq.pending&attempts=lt." + MAX_ATTEMPTS +
    "&select=*&order=created_at.asc&limit=" + BATCH).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(queued) || queued.length === 0) return json(200, { sent: 0, note: "nothing pending" });

  const cfg = await rest("email_config?purpose=eq.gp_finalized&select=*").then((r) => r.json()).catch(() => []);
  const from = cfg?.[0]
    ? `${cfg[0].from_name} <${cfg[0].from_address}>`
    : "TradeDesk <tradedesk@renewhomeext.com>";
  const threshold = cfg?.[0]?.threshold_margin_pct ?? null;

  const results: any[] = [];

  for (const q of queued) {
    let subject: string, html: string, text: string;

    if (q.purpose === "sync_flags") {
      ({ subject, html, text } = renderFlags(q.payload));
    } else if (q.purpose === "health_alert") {
      ({ subject, html, text } = renderHealth(q.payload));
    } else {
      const [f] = await rest("job_finalizations?id=eq." + q.finalization_id + "&select=*")
        .then((r) => r.json()).catch(() => []);
      const [job] = f ? await rest(
        "jobs?id=eq." + f.job_id +
        "&select=number,customer_name,customer_address,ghl_project_display_id")
        .then((r) => r.json()).catch(() => []) : [];

      if (!f || !job) {
        await rest("email_outbound?id=eq." + q.id, { method: "PATCH",
          body: JSON.stringify({ status: "cancelled", last_error: "the job or its finalization no longer exists" }) });
        results.push({ id: q.id, cancelled: true });
        continue;
      }
      const priorSent: any[] = await rest(
        "email_outbound?job_id=eq." + f.job_id + "&status=eq.sent&select=id&limit=1")
        .then((r) => r.json()).catch(() => []);
      const revised = Array.isArray(priorSent) && priorSent.length > 0;
      ({ subject, html, text } = render(job, f, revised, threshold));
    }

    if (dry) { results.push({ id: q.id, dryRun: true, purpose: q.purpose, to: q.to_addresses, subject }); continue; }

    const { ok, providerId, err } = await send(from, q.to_addresses, subject, html, text);

    await rest("email_outbound?id=eq." + q.id, {
      method: "PATCH",
      body: JSON.stringify(ok
        ? { status: "sent", sent_at: new Date().toISOString(), provider_id: providerId,
            attempts: q.attempts + 1, last_error: null }
        : { status: q.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts: q.attempts + 1, last_error: err }),
    });

    results.push({ id: q.id, ok, purpose: q.purpose, to: q.to_addresses, subject, providerId, error: err });
  }

  return json(200, { processed: results.length, dryRun: dry, results });
});
