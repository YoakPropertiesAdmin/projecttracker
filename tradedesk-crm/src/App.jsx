import React, { useState, useEffect, useMemo, useRef } from "react";
import { repo } from "./data/repository.js";
import { supabase, isSupabaseConfigured } from "./data/supabaseClient.js";
import {
  LayoutDashboard, LayoutGrid, List, Truck, TrendingUp,
  Home, Layers, AppWindow, DoorOpen,
  Plus, Minus, X, Search, Phone, Mail, MapPin, DollarSign, Check,
  ChevronDown, ChevronRight, ChevronLeft, Trash2, Pencil, Users, UserPlus,
  AlertTriangle, Tag, Building2, Menu, ClipboardList, RefreshCw,
  Wallet, HandCoins, Percent, Calendar as CalendarIcon, LogOut,
  Hammer, Wrench, PaintBucket, Droplets, Thermometer, PackageCheck, ShoppingCart,
  Download, FileSpreadsheet, SlidersHorizontal, ArrowDownUp, ShieldCheck, Link2, Lock, Send, CalendarCheck, ExternalLink
} from "lucide-react";

/* =========================================================================
   CONSTANTS & CONFIG
   ========================================================================= */

// Home-exterior trades only. If this company also does gutters, decking,
// painting, etc. just say so and this list grows — nothing else changes.
// Icons are stored in the database by name; this is the resolver. An
// unrecognised name falls back to a generic tag rather than crashing a render.
const TRADE_ICONS = {
  home: Home, layers: Layers, appwindow: AppWindow, dooropen: DoorOpen,
  hammer: Hammer, wrench: Wrench, paintbucket: PaintBucket,
  droplets: Droplets, thermometer: Thermometer, tag: Tag,
};

/**
 * Project types live in the `trades` table — adding gutters or decking is one
 * row, not a code change and a redeploy.
 *
 * This object is the in-memory view of it, seeded with the four the app
 * shipped with so a cold start (and the localStorage dev fallback) still
 * renders. It is rewritten in place rather than held in React state because
 * TradeBadge and the report builders read it from module scope in a dozen
 * places; threading it through as a prop would be a much larger change for no
 * behavioural gain. applyTrades() runs immediately before the setState that
 * triggers a render, so no render sees a half-updated registry.
 */
const TRADES = {
  roofing: { label: "Roofing", icon: Home, color: "#C1440E" },
  siding: { label: "Siding", icon: Layers, color: "#5B7B9A" },
  windows: { label: "Windows", icon: AppWindow, color: "#3F8EA6" },
  doors: { label: "Doors", icon: DoorOpen, color: "#8A6D3B" },
};

function applyTrades(rows) {
  if (!rows || !rows.length) return;
  Object.keys(TRADES).forEach((k) => delete TRADES[k]);
  rows.forEach((r) => {
    TRADES[r.key] = {
      label: r.label,
      color: r.color || "#8A8478",
      icon: TRADE_ICONS[String(r.icon || "tag").toLowerCase()] || Tag,
    };
  });
}

// Assignable types: what the registry offers.
const tradeKeys = () => Object.keys(TRADES);

// Everything worth filtering by: the registry, plus any trade actually sitting
// on a job. A project type GHL sent that nobody has mapped yet stays visible
// and filterable instead of quietly disappearing from the board controls.
const tradeKeysFor = (jobs) => {
  const keys = Object.keys(TRADES);
  (jobs || []).forEach((j) => { if (j.trade && !keys.includes(j.trade)) keys.push(j.trade); });
  return keys;
};

// A trade on a job with no registry entry — surfaced in the UI so it gets fixed.
const isUnknownTrade = (trade) => Boolean(trade) && !TRADES[trade];

/**
 * Corner markers. A job sits in a stage and may additionally carry one marker:
 * on hold, materials in, needs ordered. They come from the `job_flags` table
 * and are set either by the GHL stage on arrival or by hand in the job detail.
 *
 * Only a marker with a `tint` washes the whole card — that is reserved for
 * states that should stop the eye. The rest are a corner icon and nothing more,
 * or the board turns into a colour riot.
 */
const FLAG_ICONS = {
  alerttriangle: AlertTriangle, packagecheck: PackageCheck, shoppingcart: ShoppingCart,
  wrench: Wrench, clipboardlist: ClipboardList, tag: Tag,
};

const JOB_FLAGS = {
  on_hold:       { label: "On hold",       icon: AlertTriangle, color: "#B07D12", tint: "#FDF7EA", demote: true },
  materials_in:  { label: "Materials in",  icon: PackageCheck,  color: "#3E6B3A", tint: null, demote: false },
  needs_ordered: { label: "Needs ordered", icon: ShoppingCart,  color: "#4A5480", tint: null, demote: false },
};

function applyJobFlags(rows) {
  if (!rows || !rows.length) return;
  Object.keys(JOB_FLAGS).forEach((k) => delete JOB_FLAGS[k]);
  rows.forEach((r) => {
    JOB_FLAGS[r.key] = {
      label: r.label,
      icon: FLAG_ICONS[String(r.icon || "tag").toLowerCase()] || Tag,
      color: r.color || "#8A8478",
      tint: r.tint || null,
      demote: Boolean(r.demote),
    };
  });
}

const flagKeys = () => Object.keys(JOB_FLAGS);
const jobFlag = (job) => (job && job.flag ? JOB_FLAGS[job.flag] : null);

/**
 * Client payment classifications, from the `payment_types` registry. Same
 * mutable-module pattern as the trade and flag registries: rewritten from the
 * database immediately before the state update that renders it.
 *
 * These exist because "how much did we take in deposits last week" cannot be
 * answered from a payment method — Check, Financing and Cash say how the money
 * arrived, not what it was for.
 */
const PAYMENT_TYPES = {
  initial_deposit: { label: "Initial deposit", sort: 10 },
  second_deposit: { label: "Second deposit", sort: 20 },
  progress: { label: "Progress payment", sort: 30 },
  final_payment: { label: "Final payment", sort: 40 },
  other: { label: "Other", sort: 90 },
};

function applyPaymentTypes(rows) {
  if (!rows || !rows.length) return;
  Object.keys(PAYMENT_TYPES).forEach((k) => delete PAYMENT_TYPES[k]);
  rows.forEach((r) => { PAYMENT_TYPES[r.key] = { label: r.label, sort: r.sort_order ?? 100 }; });
}

const paymentTypeKeys = () =>
  Object.keys(PAYMENT_TYPES).sort((a, b) => PAYMENT_TYPES[a].sort - PAYMENT_TYPES[b].sort);

const paymentTypeLabel = (key) =>
  (key && PAYMENT_TYPES[key] ? PAYMENT_TYPES[key].label : "Unclassified");

/**
 * What a new payment on this job most likely is. The office can override it,
 * but defaulting to blank would mean most rows never get classified — and an
 * unclassified ledger is exactly what made deposit reporting impossible.
 */
function suggestPaymentType(job, amount) {
  const existing = (job && job.clientPayments) || [];
  const already = existing.reduce((s, p) => s + Number(p.amount || 0), 0);
  const contract = Number((job && job.contractAmount) || 0);
  const amt = Number(amount || 0);
  if (contract > 0 && amt > 0 && already + amt >= contract - 0.01) return "final_payment";
  if (existing.length === 0) return "initial_deposit";
  if (existing.length === 1) return "second_deposit";
  return "progress";
}

// Statuses that mean the job is no longer live. Kept on the board rather than
// hidden — the history and any money already collected still matter — but they
// stop competing for attention with work in progress.
const DEAD_STATUSES = { lost: "Lost", abandoned: "Abandoned" };
const deadStatus = (job) => (job && DEAD_STATUSES[job.ghlStatus]) || null;

/**
 * Ageing rules, from the `job_age_rules` registry.
 *
 * A job trips a rule when its milestone date is older than the threshold AND it
 * has not yet reached the stage the clock stops at. That second half is the
 * point: a job that took fourteen weeks to reach Scheduled is not stalled, it
 * is scheduled. Only work that has not moved is worth shouting about.
 */
const AGE_RULES = {
  signed_stale: {
    label: "Signed over 10 weeks ago", field: "contractSignedDate", weeks: 10,
    emoji: "🚩", stopsAt: "scheduled", sort: 10,
    prompt: "No contract signed date — set it so this job is tracked for ageing.",
  },
  materials_stale: {
    label: "Materials ordered over 16 weeks ago", field: "materialsOrderedDate", weeks: 16,
    emoji: "🟡", stopsAt: "scheduled", sort: 20,
    prompt: "No materials ordered date — set it once materials go on order.",
  },
};

const AGE_FIELD_BY_COLUMN = {
  contract_signed_date: "contractSignedDate",
  materials_ordered_date: "materialsOrderedDate",
};

function applyAgeRules(rows) {
  if (!rows || !rows.length) return;
  Object.keys(AGE_RULES).forEach((k) => delete AGE_RULES[k]);
  rows.forEach((r) => {
    AGE_RULES[r.key] = {
      label: r.label,
      field: AGE_FIELD_BY_COLUMN[r.date_field] || r.date_field,
      weeks: Number(r.weeks) || 0,
      emoji: r.emoji || "🚩",
      stopsAt: r.stops_at_stage || "scheduled",
      prompt: r.missing_date_prompt || "",
      sort: r.sort_order ?? 100,
    };
  });
}

const ageRuleKeys = () => Object.keys(AGE_RULES).sort((a, b) => AGE_RULES[a].sort - AGE_RULES[b].sort);

/** Position in the board order, so "has it reached Scheduled yet" is a comparison. */
const stageIndex = (key) => {
  const i = STAGES.findIndex((s) => s.key === key);
  return i === -1 ? 0 : i;
};

/** Whole weeks since a date. null when there is no usable date to count from. */
const weeksSince = (v) => {
  const d = parseDate(v);
  if (!d) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 604800000);
};

/** Which rules this job is currently in breach of. */
function ageFlags(job) {
  if (!job || deadStatus(job)) return [];
  const here = stageIndex(job.stage);
  const out = [];
  ageRuleKeys().forEach((k) => {
    const r = AGE_RULES[k];
    if (here >= stageIndex(r.stopsAt)) return;
    const w = weeksSince(job[r.field]);
    if (w === null || w < r.weeks) return;
    out.push({ key: k, weeksElapsed: w, ...r });
  });
  return out;
}

/**
 * Rules that cannot be evaluated because the date is missing, while the job is
 * still at a stage where the rule would apply. This is what makes the gap
 * visible rather than letting an undated job quietly pass as "not late".
 */
function ageDateGaps(job) {
  if (!job || deadStatus(job)) return [];
  const here = stageIndex(job.stage);
  return ageRuleKeys()
    .map((k) => ({ key: k, ...AGE_RULES[k] }))
    .filter((r) => here < stageIndex(r.stopsAt) && !r.field.startsWith("__") && !job[r.field]);
}

/**
 * Who can be put on a job, from the `assignee_roles` registry. Same mutable-
 * module pattern as the other registries.
 *
 * `scheduled` is the whole distinction: an installer and a service crew occupy
 * days, so they carry a date range and show on the calendar. A project manager
 * owns the job from signing to close — that is not a booking, and pretending it
 * is would fill the calendar with month-long bars that tell nobody anything.
 */
const ASSIGNEE_ROLES = {
  project_manager: { label: "Project manager", scheduled: false, sort: 10 },
  installer: { label: "Installer", scheduled: true, sort: 20 },
  service: { label: "Service", scheduled: true, sort: 30 },
};

function applyAssigneeRoles(rows) {
  if (!rows || !rows.length) return;
  Object.keys(ASSIGNEE_ROLES).forEach((k) => delete ASSIGNEE_ROLES[k]);
  rows.forEach((r) => {
    ASSIGNEE_ROLES[r.key] = {
      label: r.label,
      scheduled: r.scheduled !== false,
      sort: r.sort_order ?? 100,
    };
  });
}

const assigneeRoleKeys = () =>
  Object.keys(ASSIGNEE_ROLES).sort((a, b) => ASSIGNEE_ROLES[a].sort - ASSIGNEE_ROLES[b].sort);

const assigneeRole = (key) => ASSIGNEE_ROLES[key] || { label: key, scheduled: true, sort: 100 };

const scheduledRoleKeys = () => assigneeRoleKeys().filter((k) => assigneeRole(k).scheduled);

/** mm/dd/yy. The office writes dates this way, so the card reads them back the same. */
const fmtDateNum = (v) => {
  const d = parseDate(v);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "/" + p(d.getDate()) + "/" + String(d.getFullYear()).slice(-2);
};

/** "10/12/26 – 10/14/26", collapsed to one date when the range is a single day. */
const fmtDateRange = (start, end) => {
  const a = fmtDateNum(start);
  const b = fmtDateNum(end);
  if (!a && !b) return "";
  if (!b || a === b) return a;
  if (!a) return "until " + b;
  return a + " – " + b;
};

/**
 * Black or white text on a coloured block. The sixteen palette colours are all
 * dark enough for white, but a colour set by hand in the database is not bound
 * by that, and unreadable labels on someone's own calendar is a poor way to
 * find out. Relative luminance per WCAG.
 */
const textOn = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1], 16);
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.45 ? "#1B2027" : "#FFFFFF";
};

/**
 * Column ordering. A held contract is still a contract, so it keeps its column
 * — but it is not work in motion, and leaving it interleaved with live jobs
 * makes a column of five look busier than it is. Markers whose registry row
 * sets `demote` sink to the bottom; everything else holds its existing order.
 */
/**
 * How far down its column a job sits. Everything that still needs someone to do
 * something floats to the top; anything settled sinks.
 *
 *   0  live work
 *   1  held (flagged demote in the registry)
 *   2  lost or abandoned in the CRM
 *   3  marked Paid in Full / Completed — nothing left to chase, so it goes last
 *
 * The practical effect in Project Complete: jobs still owing money stay at the
 * top where the office is looking, and paid-in-full drops to the bottom.
 */
const settledRank = (job) => {
  if (isPaidCompleted(job)) return 3;
  if (deadStatus(job)) return 2;
  const f = jobFlag(job);
  if (f && f.demote) return 1;
  return 0;
};

const byColumnOrder = (a, b) => {
  const ra = settledRank(a), rb = settledRank(b);
  if (ra !== rb) return ra - rb;
  return (b.number || 0) - (a.number || 0);
};

// Job progress stages, start to finish. Rename/reorder these freely.
const STAGES = [
  { key: "signed", label: "Contract Signed" },
  { key: "permitting", label: "Permitting & Measure" },
  { key: "materials_ordered", label: "Materials Ordered" },
  { key: "scheduled", label: "Scheduled" },
  { key: "in_progress", label: "In Progress" },
  { key: "punch_list", label: "Punch List" },
  { key: "completed", label: "Completed" },
  { key: "closed", label: "Closed / Paid" },
];

const PAYMENT_METHODS = ["Check", "ACH / Bank Transfer", "Credit Card", "Cash", "Financing"];
const VENDOR_CATEGORIES = ["Materials", "Subcontractor Labor", "Permit / Fees", "Equipment / Dumpster", "Other"];

const STORAGE_KEY = "tradedesk-job-tracker-v1";

/* =========================================================================
   UTILITIES
   ========================================================================= */

const uid = (prefix) => (prefix ? prefix + "-" : "") + Math.random().toString(36).slice(2, 9);

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

const moneyDec = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (n) => Math.round((Number(n) || 0) * 100) + "%";

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// A calendar event is an instant, not a day, so the review queue needs the
// time as well. Rendered in the browser's own zone, which is the crew's.
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
};

const fmtDateShort = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const timeAgo = (iso) => {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + "d ago";
  const months = Math.floor(days / 30);
  return months + "mo ago";
};

const daysBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

const addDays = (iso, n) => {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

const isPast = (iso) => iso && new Date(iso).getTime() < Date.now();

const cls = (...parts) => parts.filter(Boolean).join(" ");

const jobNo = (n) => "JOB-" + String(n).padStart(4, "0");

/**
 * The GoHighLevel project number. This is the identifier the two systems
 * share, so it leads wherever a job is identified — JOB-nnnn is TradeDesk's
 * own sequence and means nothing to anyone looking at the CRM.
 *
 * Null for a job created by hand in TradeDesk, which never had one.
 */
const projectRef = (job) => (job && job.ghlProjectDisplayId ? "#" + job.ghlProjectDisplayId : null);
const jobRef = (job) => projectRef(job) || jobNo(job.number);

/* ---------------- job financial derivations ---------------- */

const clientReceived = (job) => (job.clientPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
// Client credits (2026-11-12): money taken off what the client owes after
// signing. Never part of Received, never a refund. The contract amount stays
// the signed figure; the credit lowers the balance due, and margin is figured
// on net revenue (contract - credits), the same as job_financials and the
// reports in the database.
const clientCredited = (job) => (job.clientCredits || []).reduce((s, c) => s + Number(c.amount || 0), 0);
const netContract = (job) => Number(job.contractAmount || 0) - clientCredited(job);
// Rounded to the cent. Float subtraction leaves crumbs — 13867.92 - 13215.75
// - 652.17 is 1.1e-13, not 0 — and a crumb above zero kept job #1101 from
// reading as paid in full, hiding the In Progress / Completed choice.
const toCents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clientBalance = (job) => toCents(Number(job.contractAmount || 0) - clientReceived(job) - clientCredited(job));
const vendorPaid = (job) => (job.vendorPayments || []).filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.amount || 0), 0);
const vendorPending = (job) => (job.vendorPayments || []).filter((p) => p.status === "pending").reduce((s, p) => s + Number(p.amount || 0), 0);
const vendorTotal = (job) => vendorPaid(job) + vendorPending(job);
const jobMargin = (job) => netContract(job) - vendorTotal(job);
const jobMarginPct = (job) => (netContract(job) ? jobMargin(job) / netContract(job) : 0);
// Credits count toward "covered" here, so a job settled by payment + credit
// fills the bar the same as one paid in cash.
const paidPct = (job) => (job.contractAmount ? Math.min(1, (clientReceived(job) + clientCredited(job)) / job.contractAmount) : 0);
// A credit amount, always shown with a true minus sign: "−$1,700.00".
const creditMoney = (n) => "\u2212" + moneyDec(Math.abs(Number(n) || 0));
// A balance that may go below zero, signed the same way: "−$15.00".
const signedMoneyDec = (n) => (Number(n) < 0 ? creditMoney(n) : moneyDec(n));
// Collected in full. Guarded on a non-zero contract so a $0 placeholder job
// doesn't read as paid the moment it is created.
const isPaidInFull = (job) => Number(job.contractAmount || 0) > 0 && clientBalance(job) <= 0;
// Being paid in full no longer finishes a job by itself (2026-11-12): someone
// says which it is. "Paid in Full / Completed" is the old behaviour — green
// card, sinks to the bottom. "Paid in Full / In Progress" is a tag only, the
// card stays where the work is. Either choice only counts while the balance
// is still covered; if it reopens, the card shows the balance due again.
const PAID_STATUSES = {
  in_progress: { label: "Paid in Full / In Progress", short: "Paid in full \u00b7 In progress" },
  completed: { label: "Paid in Full / Completed", short: "Paid in full" },
};
const paidStatusOf = (job) => (isPaidInFull(job) ? (job.paidStatus || "unset") : null);
const isPaidCompleted = (job) => paidStatusOf(job) === "completed";

/* =========================================================================
   SEED DATA
   ========================================================================= */

function buildSeedData() {
  const now = new Date();
  const iso = (daysOffset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString();
  };

  const vendors = [
    { id: "v1", name: "Ridgeline Roofing Supply", category: "Materials", phone: "412-555-0301", email: "orders@ridgelinesupply.example", notes: "Primary shingle + underlayment distributor.", createdAt: iso(-200) },
    { id: "v2", name: "Ace Siding Distributors", category: "Materials", phone: "412-555-0322", email: "sales@acesiding.example", notes: "", createdAt: iso(-180) },
    { id: "v3", name: "Coastal Window Mfg.", category: "Materials", phone: "412-555-0345", email: "orders@coastalwindow.example", notes: "6-8 week lead time on custom sizes.", createdAt: iso(-160) },
    { id: "v4", name: "Delgado Roofing Crew", category: "Subcontractor Labor", phone: "412-555-0177", email: "", notes: "Tear-off + install crew, roofing only.", createdAt: iso(-150) },
    { id: "v5", name: "Novak Installation Crew", category: "Subcontractor Labor", phone: "412-555-0198", email: "", notes: "Doors + windows install specialists.", createdAt: iso(-140) },
    { id: "v6", name: "City Permit Office", category: "Permit / Fees", phone: "412-555-0100", email: "", notes: "", createdAt: iso(-140) },
    { id: "v7", name: "Bin There Dumpster Rental", category: "Equipment / Dumpster", phone: "412-555-0288", email: "", notes: "", createdAt: iso(-130) },
  ];

  const jobs = [
    {
      id: "j1", number: 1001, customerName: "Denise Marlow", customerPhone: "412-555-0148", customerEmail: "denise.marlow@example.com",
      customerAddress: "118 Cedar Ridge Rd, Sharonville", trade: "roofing", stage: "in_progress",
      contractAmount: 14200, startDate: iso(-14), targetDate: iso(3), notes: "Insurance claim, hail damage. Adjuster already approved scope.",
      createdAt: iso(-14),
      clientPayments: [
        { id: uid("cp"), amount: 4260, date: iso(-13), method: "Check", note: "Deposit (30%)" },
        { id: uid("cp"), amount: 4970, date: iso(-2), method: "ACH / Bank Transfer", note: "Materials draw" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Ridgeline Roofing Supply", category: "Materials", amount: 5200, date: iso(-6), status: "paid", note: "Shingles, underlayment, ice & water shield" },
        { id: uid("vp"), vendorName: "Delgado Roofing Crew", category: "Subcontractor Labor", amount: 3800, date: iso(-1), status: "pending", note: "Tear-off + install, due on completion" },
        { id: uid("vp"), vendorName: "Bin There Dumpster Rental", category: "Equipment / Dumpster", amount: 450, date: iso(-6), status: "paid", note: "" },
      ],
    },
    {
      id: "j2", number: 1002, customerName: "Ray & Anna Kowalski", customerPhone: "412-555-0172", customerEmail: "kowalski.home@example.com",
      customerAddress: "42 Birchwood Ct, Millbrook", trade: "siding", stage: "materials_ordered",
      contractAmount: 18500, startDate: iso(-9), targetDate: iso(18), notes: "Full exterior, vinyl, color: Coastal Gray.",
      createdAt: iso(-9),
      clientPayments: [
        { id: uid("cp"), amount: 5550, date: iso(-8), method: "Check", note: "Deposit (30%)" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Ace Siding Distributors", category: "Materials", amount: 8100, date: iso(-3), status: "pending", note: "Full material order, awaiting delivery" },
      ],
    },
    {
      id: "j3", number: 1003, customerName: "Marcus Feld", customerPhone: "412-555-0193", customerEmail: "mfeld@example.com",
      customerAddress: "875 Overlook Ave, Fenton Heights", trade: "windows", stage: "permitting",
      contractAmount: 9600, startDate: iso(-6), targetDate: iso(24), notes: "8 double-hung replacement windows.",
      createdAt: iso(-6),
      clientPayments: [
        { id: uid("cp"), amount: 2880, date: iso(-5), method: "Credit Card", note: "Deposit (30%)" },
      ],
      vendorPayments: [],
    },
    {
      id: "j4", number: 1004, customerName: "Priya Anand", customerPhone: "412-555-0206", customerEmail: "priya.anand@example.com",
      customerAddress: "22 Thistle Ln, Sharonville", trade: "doors", stage: "punch_list",
      contractAmount: 5400, startDate: iso(-38), targetDate: iso(-2), notes: "Front + patio door replacement. Final trim touch-up scheduled.",
      createdAt: iso(-38),
      clientPayments: [
        { id: uid("cp"), amount: 1620, date: iso(-37), method: "Check", note: "Deposit (30%)" },
        { id: uid("cp"), amount: 3240, date: iso(-10), method: "ACH / Bank Transfer", note: "Progress draw" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Novak Installation Crew", category: "Subcontractor Labor", amount: 1800, date: iso(-9), status: "paid", note: "" },
      ],
    },
    {
      id: "j5", number: 1005, customerName: "Sandra Buell", customerPhone: "412-555-0184", customerEmail: "sbuell@example.com",
      customerAddress: "540 Quarry Rd, Millbrook", trade: "roofing", stage: "completed",
      contractAmount: 16800, startDate: iso(-60), targetDate: iso(-5), notes: "Roof + gutter storm claim. Passed final inspection.",
      createdAt: iso(-60),
      clientPayments: [
        { id: uid("cp"), amount: 5040, date: iso(-59), method: "Check", note: "Deposit (30%)" },
        { id: uid("cp"), amount: 8400, date: iso(-30), method: "ACH / Bank Transfer", note: "Materials + labor draw" },
        { id: uid("cp"), amount: 3360, date: iso(-4), method: "Check", note: "Final payment" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Ridgeline Roofing Supply", category: "Materials", amount: 6900, date: iso(-32), status: "paid", note: "" },
        { id: uid("vp"), vendorName: "Delgado Roofing Crew", category: "Subcontractor Labor", amount: 4200, date: iso(-6), status: "paid", note: "" },
        { id: uid("vp"), vendorName: "Bin There Dumpster Rental", category: "Equipment / Dumpster", amount: 480, date: iso(-32), status: "paid", note: "" },
      ],
    },
    {
      id: "j6", number: 1006, customerName: "Charlotte Beam", customerPhone: "412-555-0198", customerEmail: "cbeam@example.com",
      customerAddress: "9 Fairhaven Ct, Fenton Heights", trade: "siding", stage: "signed",
      contractAmount: 21000, startDate: iso(-1), targetDate: iso(35), notes: "Fiber cement siding, full exterior.",
      createdAt: iso(-1),
      clientPayments: [
        { id: uid("cp"), amount: 6300, date: iso(-1), method: "Check", note: "Deposit (30%)" },
      ],
      vendorPayments: [],
    },
    {
      id: "j7", number: 1007, customerName: "Wendy Okafor", customerPhone: "412-555-0165", customerEmail: "wokafor@example.com",
      customerAddress: "12 Grandview Ter, Sharonville", trade: "windows", stage: "scheduled",
      contractAmount: 11200, startDate: iso(-5), targetDate: iso(15), notes: "Bay window + 4 double-hungs.",
      createdAt: iso(-5),
      clientPayments: [
        { id: uid("cp"), amount: 3360, date: iso(-4), method: "Credit Card", note: "Deposit (30%)" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Coastal Window Mfg.", category: "Materials", amount: 6100, date: iso(-4), status: "pending", note: "On order, 6-8 wk lead time" },
      ],
    },
    {
      id: "j8", number: 1008, customerName: "Gene Hartwell", customerPhone: "412-555-0159", customerEmail: "ghartwell@example.com",
      customerAddress: "19 Poplar St, Sharonville", trade: "doors", stage: "closed",
      contractAmount: 4200, startDate: iso(-90), targetDate: iso(-70), notes: "Storm door + garage service door replacement.",
      createdAt: iso(-90),
      clientPayments: [
        { id: uid("cp"), amount: 4200, date: iso(-71), method: "Check", note: "Paid in full" },
      ],
      vendorPayments: [
        { id: uid("vp"), vendorName: "Novak Installation Crew", category: "Subcontractor Labor", amount: 1400, date: iso(-72), status: "paid", note: "" },
      ],
    },
  ];

  return { jobs, vendors, counters: { job: 1008 }, role: "admin" };
}

/* =========================================================================
   DATA HOOK
   ========================================================================= */

function useJobTrackerData() {
  const [data, setDataState] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready
  const [loadError, setLoadError] = useState("");
  // The ageing counters are derived from the clock, not from state, so a board
  // left open overnight would keep showing yesterday's week count and could sit
  // one day short of a flag indefinitely. One timer for the whole app rather
  // than one per card.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setAgeTick((n) => n + 1), 30 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // One read of the four tables, assembled by the repository into the nested
  // shape the views already expect. Also used to re-sync after a failed write.
  const load = React.useCallback(async () => {
    try {
      const loaded = await repo.loadAll();
      if (loaded) {
        // Rewrite the trade registry before the state update that renders it,
        // so no render observes a half-applied list.
        applyTrades(loaded.trades);
        applyJobFlags(loaded.jobFlags);
        applyPaymentTypes(loaded.paymentTypes);
        applyAgeRules(loaded.ageRules);
        applyAssigneeRoles(loaded.assigneeRoles);
        setDataState(loaded);
      } else {
        // Nothing stored at all. Only reachable in the localStorage dev
        // fallback (a fresh browser) — Supabase always returns a shape, empty
        // or not, so sample data is never written to the real database here.
        const seed = buildSeedData();
        await repo.replaceAll(seed);
        setDataState(seed);
      }
      setLoadError("");
    } catch (err) {
      setLoadError(err && err.message ? err.message : "Could not reach the database.");
      setDataState((prev) => prev || { jobs: [], vendors: [] });
    } finally {
      setStatus("ready");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setData = (updater) => {
    setDataState((prev) => (typeof updater === "function" ? updater(prev) : updater));
  };

  return { data, setData, status, reload: load, loadError };
}

/* =========================================================================
   SMALL UI ATOMS
   ========================================================================= */

function TradeBadge({ trade, size }) {
  const t = TRADES[trade] || { label: trade, icon: Tag, color: "#8A8478" };
  const Icon = t.icon;
  const small = size === "sm";
  return (
    <span className={cls("td-trade-badge", small && "td-trade-badge-sm")} style={{ "--tc": t.color }}>
      <Icon size={small ? 11 : 13} strokeWidth={2.4} />
      {t.label}
    </span>
  );
}

function StatusPill({ children, tone }) {
  return <span className={cls("td-pill", "td-pill-" + (tone || "neutral"))}>{children}</span>;
}

function IconBtn({ icon: Icon, onClick, title, danger }) {
  return (
    <button type="button" className={cls("td-iconbtn", danger && "td-iconbtn-danger")} onClick={onClick} title={title} aria-label={title}>
      <Icon size={15} strokeWidth={2.2} />
    </button>
  );
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="td-empty">
      <Icon size={28} strokeWidth={1.6} />
      <div className="td-empty-title">{title}</div>
      {sub && <div className="td-empty-sub">{sub}</div>}
    </div>
  );
}

function Modal({ title, onClose, children, footer, wide }) {
  return (
    <div className="td-modal-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cls("td-modal", wide && "td-modal-wide")}>
        <div className="td-modal-head">
          <span>{title}</span>
          <button type="button" className="td-modal-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <div className="td-modal-body">{children}</div>
        {footer && <div className="td-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="td-field">
      <span className="td-field-label">{label}</span>
      {children}
    </label>
  );
}

function TicketStat({ label, value, icon: Icon, accent, footnote }) {
  return (
    <div className="td-ticket-stat" style={{ "--tc": accent }}>
      <div className="td-ticket-stat-top">
        <span className="td-ticket-stat-label">{label}</span>
        <Icon size={16} strokeWidth={2.2} />
      </div>
      <div className="td-ticket-stat-value">{value}</div>
      {footnote && <div className="td-ticket-stat-foot">{footnote}</div>}
    </div>
  );
}

function ProgressBar({ value, tone }) {
  return (
    <div className="td-progress-track">
      <div className={cls("td-progress-fill", tone && "td-progress-" + tone)} style={{ width: Math.round(Math.max(0, Math.min(1, value)) * 100) + "%" }} />
    </div>
  );
}

/* =========================================================================
   CHARTS (hand-rolled SVG, no external chart lib)
   ========================================================================= */

function BarChart({ data, formatValue }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="td-barchart">
      {data.map((d) => (
        <div className="td-barrow" key={d.label}>
          <div className="td-barrow-label">{d.label}</div>
          <div className="td-barrow-track">
            <div className="td-barrow-fill" style={{ width: (d.value / max) * 100 + "%", background: d.color || "var(--td-accent)" }} />
          </div>
          <div className="td-barrow-value">{formatValue ? formatValue(d.value) : d.value}</div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ data, size }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = 15.9155;
  let acc = 0;
  const s = size || 128;
  return (
    <div className="td-donut-wrap" style={{ width: s, height: s }}>
      <svg viewBox="0 0 42 42" width={s} height={s}>
        <circle cx="21" cy="21" r={r} fill="transparent" stroke="var(--td-track)" strokeWidth="6" />
        {data.map((d) => {
          const pctVal = (d.value / total) * 100;
          const dash = pctVal + " " + (100 - pctVal);
          const offset = 25 - acc;
          acc += pctVal;
          return (
            <circle key={d.label} cx="21" cy="21" r={r} fill="transparent" stroke={d.color} strokeWidth="6"
              strokeDasharray={dash} strokeDashoffset={offset} strokeLinecap="butt" />
          );
        })}
      </svg>
      <div className="td-donut-center">
        <div className="td-donut-total">{total}</div>
        <div className="td-donut-total-label">total</div>
      </div>
    </div>
  );
}

/* =========================================================================
   APP SHELL
   ========================================================================= */

export default function App() {
  const { data, setData, status, reload, loadError } = useJobTrackerData();
  const [persistError, setPersistError] = useState("");
  const [view, setView] = useState("dashboard");
  const [search, setSearch] = useState("");
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [showAddJob, setShowAddJob] = useState(false);
  const [showVendorForm, setShowVendorForm] = useState(null); // null | true | vendor obj
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Hooks must run unconditionally every render; fall back to an empty shape
  // while data is still loading and branch only at the return (Rules of Hooks).
  const safeData = data || { jobs: [], vendors: [], counters: {} };

  const jobs = safeData.jobs;
  const vendors = safeData.vendors;
  const assignees = safeData.assignees || [];

  // What this login is allowed to see, as resolved by the database. This is
  // presentation only — RLS has already decided what rows arrive, and these
  // flags exist so a project manager sees no panel at all rather than a panel
  // reading $0. Anything gated on them must also be gated in Postgres.
  // The review queue is read on its own rather than through loadAll: the
  // scheduled task writes to it between page loads, so it has to be
  // refreshable without re-reading every job in the business.
  const [reviewRows, setReviewRows] = useState([]);
  const [reviewRecent, setReviewRecent] = useState([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");

  const role = safeData.role || "project_manager";
  const isAdmin = role === "admin" || role === "super_admin";
  const isSuperAdmin = role === "super_admin";

  const vendorNames = useMemo(() => vendors.map((v) => v.name), [vendors]);

  // Every assignment on the board needs its person's name and colour, and the
  // calendar asks for them once per block. A map beats a find() per render.
  const assigneeById = useMemo(() => new Map(assignees.map((a) => [a.id, a])), [assignees]);

  const vendorSpend = useMemo(() => {
    const map = {};
    vendors.forEach((v) => { map[v.name] = { paid: 0, pending: 0, jobCount: 0, jobIds: new Set() }; });
    jobs.forEach((j) => {
      (j.vendorPayments || []).forEach((p) => {
        if (!map[p.vendorName]) map[p.vendorName] = { paid: 0, pending: 0, jobCount: 0, jobIds: new Set() };
        map[p.vendorName][p.status === "paid" ? "paid" : "pending"] += Number(p.amount || 0);
        map[p.vendorName].jobIds.add(j.id);
      });
    });
    Object.values(map).forEach((v) => { v.jobCount = v.jobIds.size; });
    return map;
  }, [jobs, vendors]);

  /* ---------------- mutators ---------------- */

  const nextJobNo = () => safeData.jobs.reduce((m, j) => Math.max(m, Number(j.number) || 0), 1000) + 1;

  const newId = () =>
    (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : uid());

  /**
   * Every mutator below updates React state first so the UI stays instant,
   * then writes only the row that actually changed. That is what makes this
   * safe for two people working at once — nobody re-saves the whole dataset.
   *
   * If a write fails, the optimistic change is not left sitting on screen
   * pretending to be saved: the banner says what happened and we re-read from
   * the database so what you see is what is stored.
   */
  const persist = (work, label) => {
    Promise.resolve()
      .then(work)
      .then(() => setPersistError(""))
      .catch((err) => {
        setPersistError(
          (label || "That change") + " could not be saved — " +
          ((err && err.message) || "connection problem") + ". Showing the latest saved data."
        );
        reload();
      });
  };

  const addJob = (job) => {
    const j = {
      id: newId(), number: nextJobNo(), stage: "signed", notes: "", createdAt: new Date().toISOString(),
      clientPayments: [], clientCredits: [], vendorPayments: [], ...job,
    };
    setData((prev) => ({ ...prev, jobs: [j, ...prev.jobs] }));
    persist(async () => {
      // The database owns job numbering (a sequence), so fold the authoritative
      // number back in once the insert returns.
      const saved = await repo.createJob(j);
      setData((prev) => ({
        ...prev,
        jobs: prev.jobs.map((x) => (x.id === j.id ? { ...x, number: saved.number } : x)),
      }));
    }, "The new job");
    return j;
  };
  const updateJob = (id, patch) => {
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
    persist(() => repo.updateJob(id, patch), "The job update");
  };
  const deleteJob = (id) => {
    setData((prev) => ({ ...prev, jobs: prev.jobs.filter((j) => j.id !== id) }));
    setSelectedJobId(null);
    persist(() => repo.deleteJob(id), "Deleting the job");
  };

  const addClientPayment = (jobId, payment) => {
    const p = { id: newId(), date: new Date().toISOString(), ...payment };
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, clientPayments: [p, ...(j.clientPayments || [])] } : j)) }));
    persist(() => repo.createClientPayment(jobId, p), "The client payment");
  };
  const deleteClientPayment = (jobId, paymentId) => {
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, clientPayments: (j.clientPayments || []).filter((p) => p.id !== paymentId) } : j)) }));
    persist(() => repo.deleteClientPayment(jobId, paymentId), "Deleting the client payment");
  };

  const addClientCredit = (jobId, credit) => {
    const c = { id: newId(), date: new Date().toISOString(), reason: "", ...credit };
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, clientCredits: [c, ...(j.clientCredits || [])] } : j)) }));
    persist(() => repo.createClientCredit(jobId, c), "The client credit");
  };
  const deleteClientCredit = (jobId, creditId) => {
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, clientCredits: (j.clientCredits || []).filter((c) => c.id !== creditId) } : j)) }));
    persist(() => repo.deleteClientCredit(jobId, creditId), "Deleting the client credit");
  };

  const addVendorPayment = (jobId, payment) => {
    const p = { id: newId(), date: new Date().toISOString(), status: "pending", ...payment };
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, vendorPayments: [p, ...(j.vendorPayments || [])] } : j)) }));
    persist(() => repo.createVendorPayment(jobId, p), "The vendor payment");
  };
  const updateVendorPayment = (jobId, paymentId, patch) => {
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => (j.id === jobId
        ? { ...j, vendorPayments: (j.vendorPayments || []).map((p) => (p.id === paymentId ? { ...p, ...patch } : p)) }
        : j)),
    }));
    persist(() => repo.updateVendorPayment(jobId, paymentId, patch), "The vendor payment update");
  };
  const deleteVendorPayment = (jobId, paymentId) => {
    setData((prev) => ({ ...prev, jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, vendorPayments: (j.vendorPayments || []).filter((p) => p.id !== paymentId) } : j)) }));
    persist(() => repo.deleteVendorPayment(jobId, paymentId), "Deleting the vendor payment");
  };

  const addVendor = (vendor) => {
    const v = { id: newId(), createdAt: new Date().toISOString(), notes: "", ...vendor };
    setData((prev) => ({ ...prev, vendors: [v, ...prev.vendors] }));
    persist(() => repo.createVendor(v), "The new vendor");
    return v;
  };
  const updateVendor = (id, patch) => {
    const previousName = (safeData.vendors.find((v) => v.id === id) || {}).name;
    const renamed = patch.name !== undefined && patch.name !== previousName;
    setData((prev) => ({
      ...prev,
      vendors: prev.vendors.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      // Vendor spend is rolled up by name, so a rename has to carry the
      // payments with it or this vendor's history splits in two on screen.
      jobs: renamed
        ? prev.jobs.map((j) => ({
            ...j,
            vendorPayments: (j.vendorPayments || []).map((p) =>
              p.vendorName === previousName ? { ...p, vendorName: patch.name } : p),
          }))
        : prev.jobs,
    }));
    persist(() => repo.updateVendor(id, patch), "The vendor update");
  };
  const deleteVendor = (id) => {
    setData((prev) => ({ ...prev, vendors: prev.vendors.filter((v) => v.id !== id) }));
    persist(() => repo.deleteVendor(id), "Deleting the vendor");
  };

  /**
   * Put someone on a job.
   *
   * `name` is a write-in; `assigneeId` is a pick from the dropdown. The two
   * paths differ in one way that matters: a write-in has to reach the database
   * and come back before anything can be drawn, because the id and the colour
   * are both allocated there. Guessing a colour locally and reconciling later
   * would mean two people adding the same installer at the same moment watch
   * his colour change under them.
   */
  const addAssignment = async ({ jobId, role, assigneeId, name, startDate, endDate, note }) => {
    let person = assigneeId ? assigneeById.get(assigneeId) : null;

    if (!person) {
      try {
        person = await repo.ensureAssignee(role, name);
      } catch (err) {
        setPersistError(
          "Could not add " + (String(name || "").trim() || "that person") + " — " +
          ((err && err.message) || "connection problem") + "."
        );
        return;
      }
      // Already present means another tab or another person got there first;
      // either way the row we just resolved is the one to keep.
      setData((prev) => ({
        ...prev,
        assignees: (prev.assignees || []).some((a) => a.id === person.id)
          ? (prev.assignees || []).map((a) => (a.id === person.id ? person : a))
          : [...(prev.assignees || []), person],
      }));
    }

    const a = {
      id: newId(), jobId, role, assigneeId: person.id,
      startDate: startDate || null, endDate: endDate || null, note: note || "",
    };
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => (j.id === jobId ? { ...j, assignments: [...(j.assignments || []), a] } : j)),
    }));
    persist(() => repo.createAssignment(jobId, a), "The assignment");
  };

  const updateAssignment = (jobId, assignmentId, patch) => {
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => (j.id === jobId
        ? { ...j, assignments: (j.assignments || []).map((a) => (a.id === assignmentId ? { ...a, ...patch } : a)) }
        : j)),
    }));
    persist(() => repo.updateAssignment(assignmentId, patch), "The assignment update");
  };

  const removeAssignment = (jobId, assignmentId) => {
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => (j.id === jobId
        ? { ...j, assignments: (j.assignments || []).filter((a) => a.id !== assignmentId) }
        : j)),
    }));
    persist(() => repo.deleteAssignment(assignmentId), "Removing the assignment");
  };

  const loadReview = React.useCallback(async () => {
    if (!isAdmin) { setReviewRows([]); setReviewRecent([]); return; }
    setReviewLoading(true);
    try {
      const [pending, recent] = await Promise.all([
        repo.loadScheduleReview(), repo.loadScheduleReviewRecent()]);
      setReviewRows(pending);
      setReviewRecent(recent);
      setReviewError("");
    } catch (e) {
      setReviewError(e && e.message ? e.message : "Could not read the review queue.");
    } finally {
      setReviewLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadReview(); }, [loadReview]);

  const signOut = () => { if (isSupabaseConfigured) supabase.auth.signOut(); };

  const ctx = {
    data: safeData, jobs, vendors, vendorNames, vendorSpend,
    assignees, assigneeById,
    role, isAdmin, isSuperAdmin, reload,
    reviewRows, reviewRecent, reviewLoading, reviewError, loadReview,
    addJob, updateJob, deleteJob,
    addClientPayment, deleteClientPayment, addClientCredit, deleteClientCredit,
    addVendorPayment, updateVendorPayment, deleteVendorPayment,
    addVendor, updateVendor, deleteVendor,
    addAssignment, updateAssignment, removeAssignment,
    selectedJobId, setSelectedJobId, showAddJob, setShowAddJob, showVendorForm, setShowVendorForm,
    search, setSearch,
  };

  const NAV = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "jobs", label: "Jobs", icon: LayoutGrid },
    { key: "calendar", label: "Calendar", icon: CalendarIcon },
    // The vendor directory and the reports are both whole-company money, so
    // they are not offered to a project manager. The tables behind them are
    // closed to that role too; this only stops the empty screen.
    ...(isAdmin ? [
      { key: "vendors", label: "Vendors", icon: Truck },
      { key: "reports", label: "Reports", icon: TrendingUp },
      // The query tool over every payment and cost; the named reports above are
      // what ownership reads, this is what the office digs with.
      { key: "ledger", label: "Ledger", icon: List },
      // The badge is the whole point of the nav entry: nobody opens a queue
      // page speculatively, so the count has to come to them.
      { key: "schedule", label: "Schedule review", icon: CalendarCheck, badge: reviewRows.length },
    ] : []),
    ...(isSuperAdmin ? [{ key: "access", label: "Access", icon: ShieldCheck }] : []),
  ];

  // A role change mid-session (or a stale tab) could leave the view pointing
  // at a screen this login no longer has.
  const safeView = NAV.some((n) => n.key === view) ? view : "dashboard";

  // All hooks above run unconditionally on every render; only the returned
  // JSX branches on load state, which keeps hook order stable (Rules of Hooks).
  if (status === "loading" || !data) {
    return (
      <div className="td-root td-loading-screen">
        <GlobalStyle />
        <RefreshCw size={22} className="td-spin" />
        <div>Loading TradeDesk…</div>
      </div>
    );
  }

  return (
    <div className="td-root">
      <GlobalStyle />
      <style>{`
        .td-overage-hint{display:flex;align-items:center;gap:7px;margin:8px 0 2px;padding:7px 10px;
          border-radius:7px;background:#FDF3E3;color:#8A5A12;font-size:12px;line-height:1.35;}
        .td-overage-hint-loss{background:#FBEDE9;color:#9B3A20;}
        .td-sync-banner{display:flex;align-items:center;gap:9px;margin:0 20px;padding:10px 13px;border-radius:9px;
          background:#FBEDE9;color:#9B3A20;font-size:12.5px;line-height:1.4;}
        .td-sync-banner span{flex:1;}
        .td-sync-banner button{border:1px solid rgba(155,58,32,.35);background:transparent;color:inherit;
          border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;}
        .td-signout{display:flex;align-items:center;gap:8px;width:100%;margin-bottom:14px;padding:7px 9px;
          border:1px solid rgba(245,242,236,.18);background:transparent;color:inherit;border-radius:7px;
          font:inherit;font-size:12.5px;cursor:pointer;opacity:.75;}
        .td-signout:hover{opacity:1;}
      `}</style>
      <div className={cls("td-shell", sidebarOpen && "td-sidebar-open")}>
        <aside className="td-sidebar">
          <div className="td-brand">
            <div className="td-brand-mark"><ClipboardList size={17} strokeWidth={2.4} /></div>
            <div>
              <div className="td-brand-name">TradeDesk</div>
              <div className="td-brand-tag">Job & payment tracker</div>
            </div>
          </div>
          <nav className="td-nav">
            {NAV.map((n) => (
              <button key={n.key} type="button"
                className={cls("td-nav-item", safeView === n.key && "active")}
                onClick={() => { setView(n.key); setSidebarOpen(false); }}>
                <n.icon size={16} strokeWidth={2.2} />
                <span>{n.label}</span>
                {n.badge > 0 && <span className="td-nav-badge">{n.badge}</span>}
              </button>
            ))}
          </nav>
          <div className="td-sidebar-foot">
            {isSupabaseConfigured && (
              <button type="button" className="td-signout" onClick={signOut}>
                <LogOut size={14} /> <span>Sign out</span>
              </button>
            )}
            <div className="td-trade-legend-title">Trades served</div>
            <div className="td-trade-legend">
              {tradeKeys().map((k) => {
                const t = TRADES[k];
                const Icon = t.icon;
                return <span key={k} className="td-legend-chip" title={t.label} style={{ "--tc": t.color }}><Icon size={12} /></span>;
              })}
            </div>
          </div>
        </aside>

        <div className="td-main">
          <header className="td-topbar">
            <button className="td-hamburger" onClick={() => setSidebarOpen((v) => !v)} aria-label="Menu"><Menu size={18} /></button>
            <div className="td-topbar-title">{NAV.find((n) => n.key === safeView)?.label}</div>
            <div className="td-topbar-search">
              <Search size={14} />
              <input placeholder="Search by customer, address, project # or job #…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {isAdmin && (
              <button className="td-btn td-btn-primary" onClick={() => setShowAddJob(true)}>
                <Plus size={15} /> New job
              </button>
            )}
          </header>

          {(loadError || persistError) && (
            <div className="td-sync-banner">
              <AlertTriangle size={15} />
              <span>{loadError || persistError}</span>
              <button type="button" onClick={() => { setPersistError(""); reload(); }}>Retry</button>
            </div>
          )}

          <main className="td-content">
            {safeView === "dashboard" && <DashboardView ctx={ctx} setView={setView} />}
            {safeView === "jobs" && <JobsView ctx={ctx} />}
            {safeView === "calendar" && <CalendarView ctx={ctx} />}
            {safeView === "vendors" && isAdmin && <VendorsView ctx={ctx} />}
            {safeView === "reports" && isAdmin && <ReportsView />}
            {safeView === "ledger" && isAdmin && <LedgerView ctx={ctx} />}
            {safeView === "schedule" && isAdmin && <ScheduleReviewView ctx={ctx} />}
            {safeView === "access" && isSuperAdmin && <AccessView ctx={ctx} />}
          </main>
        </div>
      </div>

      {selectedJobId && (
        <JobDetailModal ctx={ctx} job={jobs.find((j) => j.id === selectedJobId)} onClose={() => setSelectedJobId(null)} />
      )}
      {showAddJob && (
        <JobFormModal onClose={() => setShowAddJob(false)}
          onSave={(j) => { const created = addJob(j); setShowAddJob(false); setSelectedJobId(created.id); }} />
      )}
      {showVendorForm && (
        <VendorFormModal initial={showVendorForm === true ? null : showVendorForm} onClose={() => setShowVendorForm(null)}
          onSave={(v) => {
            if (showVendorForm === true) addVendor(v);
            else updateVendor(showVendorForm.id, v);
            setShowVendorForm(null);
          }} />
      )}
    </div>
  );
}

/* =========================================================================
   DASHBOARD
   ========================================================================= */

function DashboardView({ ctx, setView }) {
  const { jobs } = ctx;
  const activeJobs = jobs.filter((j) => j.stage !== "closed");
  const activeContractValue = activeJobs.reduce((s, j) => s + Number(j.contractAmount || 0), 0);
  const arOutstanding = jobs.reduce((s, j) => s + Math.max(0, clientBalance(j)), 0);
  const apOutstanding = jobs.reduce((s, j) => s + vendorPending(j), 0);

  const jobsByStage = STAGES.map((s) => ({
    label: s.label,
    value: jobs.filter((j) => j.stage === s.key).length,
    color: s.key === "closed" ? "#3F7D58" : "#3F8EA6",
  }));

  const atRisk = activeJobs
    .filter((j) => j.targetDate && isPast(j.targetDate) && j.stage !== "completed")
    .sort((a, b) => new Date(a.targetDate) - new Date(b.targetDate))
    .slice(0, 5);

  const activity = [];
  jobs.forEach((j) => {
    (j.clientPayments || []).forEach((p) => activity.push({ kind: "client", jobId: j.id, jobLabel: jobNo(j.number) + " · " + j.customerName, amount: p.amount, date: p.date, note: p.note }));
    (j.vendorPayments || []).forEach((p) => activity.push({ kind: "vendor", jobId: j.id, jobLabel: jobNo(j.number) + " · " + j.customerName, amount: p.amount, date: p.date, note: p.vendorName, status: p.status }));
  });
  activity.sort((a, b) => new Date(b.date) - new Date(a.date));
  const recentActivity = activity.slice(0, 6);

  return (
    <div className="td-view">
      <div className="td-stat-row">
        <TicketStat label="Active jobs" value={activeJobs.length} icon={LayoutGrid} accent="#3F8EA6" footnote={jobs.length + " total"} />
        <TicketStat label="Active contract value" value={money(activeContractValue)} icon={DollarSign} accent="#B8860B" />
        {ctx.isAdmin && (
          <>
            <TicketStat label="Client balance outstanding" value={money(arOutstanding)} icon={Wallet} accent="#C1440E" footnote="Owed to you" />
            <TicketStat label="Vendor balance outstanding" value={money(apOutstanding)} icon={HandCoins} accent="#B23A2E" footnote="You owe" />
          </>
        )}
      </div>

      <div className="td-dash-grid">
        <div className="td-panel">
          <div className="td-panel-head">
            <span>Jobs by stage</span>
            <button className="td-link-btn" onClick={() => setView("jobs")}>View board <ChevronRight size={13} /></button>
          </div>
          <BarChart data={jobsByStage} formatValue={(v) => v} />
        </div>

        <div className="td-panel">
          <div className="td-panel-head"><span>Behind schedule</span></div>
          {atRisk.length === 0 ? (
            <EmptyState icon={CalendarIcon} title="Nothing behind schedule" sub="Jobs past their target date will show up here." />
          ) : (
            <div className="td-list">
              {atRisk.map((j) => (
                <button key={j.id} className="td-list-row" onClick={() => ctx.setSelectedJobId(j.id)}>
                  <TradeBadge trade={j.trade} size="sm" />
                  <div className="td-list-row-main">
                    <div className="td-list-row-title">{j.customerName}</div>
                    <div className="td-list-row-sub">{jobNo(j.number)} · target was {fmtDateShort(j.targetDate)}</div>
                  </div>
                  <StatusPill tone="red">{Math.abs(daysBetween(j.targetDate, new Date())) + "d late"}</StatusPill>
                </button>
              ))}
            </div>
          )}
        </div>

        {ctx.isAdmin && (
        <div className="td-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="td-panel-head"><span>Recent payment activity</span></div>
          {recentActivity.length === 0 ? (
            <EmptyState icon={Wallet} title="No payments logged yet" />
          ) : (
            <div className="td-list">
              {recentActivity.map((a, i) => (
                <button key={i} className="td-list-row" onClick={() => ctx.setSelectedJobId(a.jobId)}>
                  <div className="td-comm-icon">{a.kind === "client" ? <Wallet size={13} /> : <HandCoins size={13} />}</div>
                  <div className="td-list-row-main">
                    <div className="td-list-row-title">
                      {a.kind === "client" ? "Received " + money(a.amount) + " from client" : (a.status === "paid" ? "Paid " : "Bill logged: ") + money(a.amount) + " to " + a.note}
                    </div>
                    <div className="td-list-row-sub">{a.jobLabel}{a.kind === "client" && a.note ? " · " + a.note : ""}</div>
                  </div>
                  <div className="td-list-row-end">{timeAgo(a.date)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   JOBS (BOARD + LIST)
   ========================================================================= */

function JobsView({ ctx }) {
  const { jobs, search, setSelectedJobId, updateJob } = ctx;
  const [mode, setMode] = useState("board");
  const [tradeFilter, setTradeFilter] = useState("all");
  const [repairsOnly, setRepairsOnly] = useState(false);
  const [flagFilter, setFlagFilter] = useState("all");
  const [dragOverStage, setDragOverStage] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  const matches = (j) => {
    // Combo jobs answer to each of their component trades, so filtering by
    // Roofing includes a roof-and-siding job rather than hiding it under Combo.
    if (tradeFilter !== "all" && j.trade !== tradeFilter &&
        !(j.trades || []).includes(tradeFilter)) return false;
    if (repairsOnly && !j.isRepair) return false;
    // "none" is a real answer here — showing only the jobs carrying no marker
    // is how you see what is actually moving.
    if (flagFilter === "none" && j.flag) return false;
    if (flagFilter !== "all" && flagFilter !== "none" && j.flag !== flagFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return j.customerName.toLowerCase().includes(q)
      || j.customerAddress.toLowerCase().includes(q)
      || jobNo(j.number).toLowerCase().includes(q)
      // Searchable by GHL project number, with or without the leading '#'.
      || String(j.ghlProjectDisplayId || "").toLowerCase().includes(q.replace(/^#/, ""));
  };

  const visible = jobs.filter(matches);

  const onDrop = (stageKey) => (e) => {
    e.preventDefault();
    // The stage is the board position, and a project manager does not move
    // jobs across the board. The trigger on `jobs` refuses it anyway.
    if (!ctx.isAdmin) { setDragOverStage(null); setDraggingId(null); return; }
    const id = e.dataTransfer.getData("text/plain");
    if (id) updateJob(id, { stage: stageKey });
    setDragOverStage(null);
    setDraggingId(null);
  };

  return (
    <div className={cls("td-view", mode === "board" && "td-view-flush")}>
      <div className="td-toolbar">
        <div className="td-filter-group">
          <div className="td-segment">
            <button className={cls("td-segment-btn", mode === "board" && "active")} onClick={() => setMode("board")}>Board</button>
            <button className={cls("td-segment-btn", mode === "list" && "active")} onClick={() => setMode("list")}>List</button>
          </div>
          <select value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)} className="td-select">
            <option value="all">All trades</option>
            {tradeKeysFor(jobs).map((k) => (
              <option key={k} value={k}>{TRADES[k] ? TRADES[k].label : k + " (unmapped)"}</option>
            ))}
          </select>
          <select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value)}
            className={cls("td-select", flagFilter !== "all" && "td-select-on")}>
            <option value="all">All markers</option>
            <option value="none">No marker</option>
            {flagKeys().map((k) => <option key={k} value={k}>{JOB_FLAGS[k].label}</option>)}
          </select>
          <button type="button"
            className={cls("td-repair-filter", repairsOnly && "active")}
            onClick={() => setRepairsOnly((v) => !v)}
            title="Show only repair work">
            <Wrench size={13} /> Repairs
          </button>
        </div>
      </div>

      {mode === "board" ? (
        visible.length === 0 ? <EmptyState icon={LayoutGrid} title="No jobs match" sub="Try clearing filters, or start a new job." /> : (
          <div className="td-kanban">
            {STAGES.map((stage) => {
              const stageJobs = visible.filter((j) => j.stage === stage.key);
              const total = stageJobs.reduce((s, j) => s + Number(j.contractAmount || 0), 0);
              return (
                <div key={stage.key}
                  className={cls("td-kanban-col", dragOverStage === stage.key && "td-kanban-col-over")}
                  onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage.key); }}
                  onDragLeave={() => setDragOverStage((s) => (s === stage.key ? null : s))}
                  onDrop={onDrop(stage.key)}>
                  <div className="td-kanban-col-head">
                    <span>{stage.label}</span>
                    <span className="td-kanban-count">{stageJobs.length}</span>
                  </div>
                  <div className="td-kanban-col-total">{money(total)}</div>
                  <div className="td-kanban-col-body">
                    {[...stageJobs].sort(byColumnOrder).map((j) => (
                      <JobTicket key={j.id} job={j} ctx={ctx} dragging={draggingId === j.id}
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", j.id); setDraggingId(j.id); }}
                        onDragEnd={() => setDraggingId(null)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        visible.length === 0 ? <EmptyState icon={LayoutGrid} title="No jobs match" sub="Try clearing filters, or start a new job." /> : (
          <div className="td-table-wrap">
            <table className="td-table">
              <thead><tr><th>Project #</th><th>Customer</th><th>Trade</th><th>Stage</th><th>Contract</th><th>Balance due</th><th>Vendor owed</th><th>Target</th></tr></thead>
              <tbody>
                {[...visible].sort(byColumnOrder).map((j) => {
                  const bal = clientBalance(j);
                  const owed = vendorPending(j);
                  return (
                    <tr key={j.id} className="td-table-row" onClick={() => setSelectedJobId(j.id)}>
                      <td className="td-mono">
                        {jobRef(j)}
                        {projectRef(j) && <div className="td-cell-sub td-mono">{jobNo(j.number)}</div>}
                      </td>
                      <td>
                        <div className="td-cell-name">
                          {jobFlag(j) && React.createElement(jobFlag(j).icon, {
                            size: 12, className: "td-flag-icon",
                            style: { color: jobFlag(j).color }, "aria-label": jobFlag(j).label })}
                          {j.isRepair && <Wrench size={12} className="td-repair-icon" aria-label="Repair" />}
                          {j.customerName}
                        </div>
                        <div className="td-cell-sub"><MapPin size={11} /> {j.customerAddress}</div>
                      </td>
                      <td><TradeBadge trade={j.trade} size="sm" /></td>
                      <td>
                        <StatusPill tone={deadStatus(j) ? "red" : j.flag === "on_hold" ? "amber" : j.stage === "closed" ? "green" : "neutral"}>
                          {deadStatus(j) || (jobFlag(j) ? jobFlag(j).label : STAGES.find((s) => s.key === j.stage)?.label)}
                        </StatusPill>
                        {j.substage && <div className="td-cell-sub">{j.substage}</div>}
                      </td>
                      <td>{money(j.contractAmount)}</td>
                      <td className={bal > 0 ? "td-text-red" : "td-text-green"}>
                        {isPaidInFull(j)
                          ? (PAID_STATUSES[j.paidStatus] ? PAID_STATUSES[j.paidStatus].short : "Paid in full")
                          : money(bal)}
                      </td>
                      <td className={owed > 0 ? "td-text-red" : "td-cell-sub"}>{owed > 0 ? money(owed) : "—"}</td>
                      <td className="td-mono">{fmtDateShort(j.targetDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function JobTicket({ job, ctx, dragging, onDragStart, onDragEnd }) {
  const t = TRADES[job.trade];
  // A project manager gets no payment rows at all, so these would read as a
  // full balance due on every card. The contract amount stays — that is the
  // job's worth, which they are meant to see.
  const bal = ctx.isAdmin ? clientBalance(job) : 0;
  const owed = ctx.isAdmin ? vendorPending(job) : 0;
  // null (not paid in full), "unset", "in_progress" or "completed". Only
  // "completed" turns the card green.
  const paidState = ctx.isAdmin ? paidStatusOf(job) : null;
  const paid = paidState === "completed";
  // Stalled past a threshold and still short of Scheduled. Overrides the hold
  // tint below: a held job that has also gone quiet for ten weeks is the more
  // urgent fact, and two pale washes fighting each other says neither.
  const overdue = ageFlags(job);
  const isOverdue = overdue.length > 0;
  // A held job keeps its column and gets a marker — a hold is a fact about the
  // job, not a step backwards, so it must not read as a fresh contract.
  return (
    <div className={cls("td-ticket", dragging && "td-ticket-dragging",
                        paid && "td-ticket-paid", deadStatus(job) && "td-ticket-dead",
                        isOverdue && "td-ticket-overdue")}
      style={{ "--tc": t ? t.color : "#8A8478",
               ...(jobFlag(job) && jobFlag(job).tint ? { background: jobFlag(job).tint, borderColor: "#E6D3A6" } : {}),
               ...(isOverdue ? { background: "#FBE0DA", borderColor: "#C25B47" } : {}) }}
      draggable={ctx.isAdmin} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={() => ctx.setSelectedJobId(job.id)}>
      {(jobFlag(job) || isOverdue) && (
        <span className="td-ticket-flagmark">
          {overdue.map((r) => (
            <span key={r.key} className="td-age-emoji"
              title={r.label + " — " + r.weeksElapsed + " weeks, still not scheduled"}>{r.emoji}</span>
          ))}
          {jobFlag(job) && (
            <span style={{ color: jobFlag(job).color, display: "inline-flex" }} title={jobFlag(job).label}>
              {React.createElement(jobFlag(job).icon, { size: 13, strokeWidth: 2.6 })}
            </span>
          )}
        </span>
      )}
      <div className="td-ticket-head">
        <span className="td-ticket-no">{jobRef(job)}</span>
        <TradeBadge trade={job.trade} size="sm" />
      </div>
      {/* Both numbers, because the office reconciles against GHL by project
          number while vendor payments and reports still cite JOB-nnnn. */}
      {projectRef(job) && <div className="td-ticket-jobno">{jobNo(job.number)}</div>}
      <div className="td-ticket-title">{job.customerName}</div>
      <div className="td-ticket-contact">{job.customerAddress}</div>
      {/* The GHL stage as sent. The board column is coarse on purpose; this is
          where "Ordered" stops looking identical to "Materials In". */}
      {(job.substage || (job.trades && job.trades.length > 1)) && (
        <div className="td-ticket-substage">
          {job.trades && job.trades.length > 1 && (
            <span className="td-combo-parts">
              {job.trades.map((k) => (TRADES[k] ? TRADES[k].label : k)).join(" + ")}
            </span>
          )}
          {job.substage && <span>{job.substage}</span>}
        </div>
      )}
      <div className="td-ticket-foot">
        <span className="td-ticket-value">{money(job.contractAmount)}
          {job.groupId && (() => {
            const n = ctx.jobs.filter((j) => j.groupId === job.groupId).length;
            return n > 1 ? <span className="td-linked-badge" title={"Linked to " + (n - 1) + " other job" + (n > 2 ? "s" : "") + " in this project"}><Link2 size={10} /> {n}</span> : null;
          })()}
        </span>
        <span className="td-ticket-date">{fmtDateShort(job.targetDate)}</span>
      </div>
      {(paidState || bal > 0 || owed > 0 || job.isRepair || deadStatus(job) || isOverdue) && (
        <div className="td-ticket-flags">
          {/* The counter, not just the flag: "14w since signed" tells you how
              bad it is, where a red card only tells you that it is bad. */}
          {overdue.map((r) => (
            <span key={r.key} className="td-ticket-flag td-ticket-flag-overdue" title={r.label}>
              {r.emoji} {r.weeksElapsed}w since {r.field === "materialsOrderedDate" ? "ordered" : "signed"}
            </span>
          ))}
          {deadStatus(job) && <span className="td-ticket-flag td-ticket-flag-red"><X size={10} /> {deadStatus(job)}</span>}
          {job.isRepair && <span className="td-ticket-flag td-ticket-flag-repair"><Wrench size={10} /> Repair</span>}
          {paidState
            ? <span className={cls("td-ticket-flag", paidState === "unset" ? "td-ticket-flag-neutral" : "td-ticket-flag-green")}
                title={paidState === "unset" ? "Paid in full — open the job to mark it In Progress or Completed" : undefined}>
                <Check size={10} /> {PAID_STATUSES[paidState] ? PAID_STATUSES[paidState].short : "Paid in full"}
              </span>
            : bal > 0 && <span className="td-ticket-flag td-ticket-flag-red"><Wallet size={10} /> {money(bal)} due</span>}
          {owed > 0 && <span className="td-ticket-flag td-ticket-flag-amber"><HandCoins size={10} /> {money(owed)} owed</span>}
        </div>
      )}
    </div>
  );
}

function JobFormModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    customerName: "", customerPhone: "", customerEmail: "", customerAddress: "",
    trade: "roofing", contractAmount: "", startDate: new Date().toISOString().slice(0, 10),
    targetDate: addDays(null, 21).slice(0, 10), stage: "signed", notes: "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = form.customerName.trim() && form.customerAddress.trim() && form.contractAmount;

  return (
    <Modal title="New job" onClose={onClose}
      footer={<>
        <button className="td-btn" onClick={onClose}>Cancel</button>
        <button className="td-btn td-btn-primary" disabled={!valid} onClick={() => valid && onSave({
          ...form, contractAmount: Number(form.contractAmount),
          startDate: new Date(form.startDate).toISOString(), targetDate: new Date(form.targetDate).toISOString(),
        })}>Create job</button>
      </>}>
      <div className="td-form-grid">
        <Field label="Customer name"><input className="td-input" value={form.customerName} onChange={set("customerName")} placeholder="Jane Homeowner" /></Field>
        <Field label="Phone"><input className="td-input" value={form.customerPhone} onChange={set("customerPhone")} placeholder="412-555-0100" /></Field>
        <Field label="Email"><input className="td-input" value={form.customerEmail} onChange={set("customerEmail")} placeholder="jane@example.com" /></Field>
        <Field label="Trade">
          <select className="td-select td-select-full" value={form.trade} onChange={set("trade")}>
            {tradeKeys().map((k) => <option key={k} value={k}>{TRADES[k].label}</option>)}
          </select>
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Job address"><input className="td-input" value={form.customerAddress} onChange={set("customerAddress")} placeholder="123 Main St, Sharonville" /></Field>
        </div>
        <Field label="Contract amount ($)"><input className="td-input td-input-num" type="number" value={form.contractAmount} onChange={set("contractAmount")} placeholder="14200" /></Field>
        <Field label="Starting stage">
          <select className="td-select td-select-full" value={form.stage} onChange={set("stage")}>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Start date"><input className="td-input" type="date" value={form.startDate} onChange={set("startDate")} /></Field>
        <Field label="Target completion"><input className="td-input" type="date" value={form.targetDate} onChange={set("targetDate")} /></Field>
      </div>
    </Modal>
  );
}

/* =========================================================================
   JOB DETAIL (stage, client payments, vendor payments, profitability)
   ========================================================================= */

/* =========================================================================
   LINKED JOBS — one customer project, several jobs
   =========================================================================
   A second phase, an add-on or a re-sell after a cancellation is its own job
   (own contract, payments, stage) but belongs with the first. The database
   groups jobs that share a GHL project # automatically (jobs_auto_group), so
   a new opportunity on an existing project arrives as a linked job instead of
   overwriting or being rejected; the office can also link any two by hand. */
function LinkedJobs({ ctx, job }) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const siblings = job.groupId ? ctx.jobs.filter((j) => j.groupId === job.groupId) : [job];
  const others = siblings.filter((j) => j.id !== job.id).sort((a, b) => a.number - b.number);
  if (!others.length && !ctx.isAdmin) return null;

  const live = siblings.filter((j) => !["lost", "abandoned"].includes(j.ghlStatus));
  const total = live.reduce((s, j) => s + Number(j.contractAmount || 0), 0);
  const received = live.reduce((s, j) => s + clientReceived(j), 0);
  const credited = live.reduce((s, j) => s + clientCredited(j), 0);

  const run = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await ctx.reload(); setTarget(""); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const link = () => {
    const n = Number(String(target).replace(/\D/g, ""));
    const other = ctx.jobs.find((j) => Number(j.number) === n);
    if (!other) { setErr("No job " + jobNo(n || target)); return; }
    if (other.id === job.id) { setErr("That is this job"); return; }
    run(() => repo.linkJobs(job.id, other.id));
  };

  return (
    <div className="td-linked">
      <div className="td-linked-head">
        <span><Link2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          {others.length ? "Linked jobs — " + siblings.length + " in this project" : "Linked jobs"}</span>
        {others.length > 0 && ctx.isAdmin && (
          <span className="td-linked-total">{money(total)} contract · {money(received)} received{credited > 0 ? " \u00b7 \u2212" + money(credited) + " credited" : ""} · {money(total - received - credited)} balance</span>
        )}
      </div>
      {others.length > 0 && (
        <ul className="td-linked-list">
          {others.map((j) => (
            <li key={j.id}>
              <button className="td-link-btn" onClick={() => ctx.setSelectedJobId(j.id)}>{jobNo(j.number)}</button>
              <span>{TRADES[j.trade] ? TRADES[j.trade].label : j.trade}</span>
              <span className="td-cell-sub">{j.contractSignedDate ? fmtDate(j.contractSignedDate + "T00:00:00") : "—"}</span>
              <span>{(STAGES.find((s) => s.key === j.stage) || {}).label || j.stage}</span>
              {["lost", "abandoned"].includes(j.ghlStatus) && <span className="td-linked-lost">{j.ghlStatus}</span>}
              {ctx.isAdmin && <span className="td-num">{money(j.contractAmount)}</span>}
              {ctx.isAdmin && (
                <button className="td-iconbtn" title="Unlink this job from the project" disabled={busy}
                  onClick={() => run(() => repo.unlinkJob(j.id))}><X size={12} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ctx.isAdmin && (
        <div className="td-linked-add">
          <input className="td-input" placeholder="Job # to link, e.g. 1447" value={target}
            onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") link(); }} />
          <button className="td-btn" disabled={busy || !target.trim()} onClick={link}><Link2 size={13} /> Link</button>
        </div>
      )}
      {err && <div className="td-linked-err">{err}</div>}
    </div>
  );
}

function JobDetailModal({ ctx, job, onClose }) {
  const { updateJob, deleteJob, addClientPayment, deleteClientPayment, addClientCredit, deleteClientCredit, addVendorPayment, updateVendorPayment, deleteVendorPayment, vendorNames } = ctx;
  const [notes, setNotes] = useState(job?.notes || "");
  const [name, setName] = useState(job?.customerName || "");
  const [phone, setPhone] = useState(job?.customerPhone || "");
  const [email, setEmail] = useState(job?.customerEmail || "");
  const [cpForm, setCpForm] = useState({ amount: "", date: new Date().toISOString().slice(0, 10), method: PAYMENT_METHODS[0], note: "", paymentType: "" });
  // The Apply credit form. Closed by default so the payment form stays the
  // obvious thing to use; credits are the exception.
  const [ccOpen, setCcOpen] = useState(false);
  const [ccForm, setCcForm] = useState({ amount: "", date: new Date().toISOString().slice(0, 10), reason: "" });
  const [vpForm, setVpForm] = useState({ vendorName: "", category: VENDOR_CATEGORIES[0], amount: "", date: new Date().toISOString().slice(0, 10), status: "pending", note: "" });

  if (!job) return null;

  // A project manager can change the notes on a job and the dates of their own
  // assignment, and nothing else. Both guard triggers in the database enforce
  // that; this keeps the controls off the screen rather than letting someone
  // type into a field whose save will be refused.
  const canManage = ctx.isAdmin;

  // The customer name identifies nothing — a job is keyed by its number and
  // matched to the CRM on the opportunity id — so a name the sync got wrong,
  // or sent as the site address, is just text to correct. Committed on blur
  // rather than onChange, which would be one write per keystroke, and an empty
  // box snaps back: the column is NOT NULL and a nameless card is unusable.
  const commitName = () => {
    const next = name.trim();
    if (!next) { setName(job.customerName); return; }
    if (next !== job.customerName) updateJob(job.id, { customerName: next });
  };

  // Phone and email are the same deal minus the empty-value rule: clearing a
  // wrong number is a real edit, and both columns default to ''. Compared
  // against the stored value so tabbing through a field writes nothing.
  const commitContact = (key, value, current) => {
    const next = value.trim();
    if (next !== (current || "")) updateJob(job.id, { [key]: next });
  };

  const received = clientReceived(job);
  const credited = clientCredited(job);
  const balance = clientBalance(job);
  const vPaid = vendorPaid(job);
  const vPending = vendorPending(job);
  const margin = jobMargin(job);
  const marginPercent = jobMarginPct(job);
  const fin = job.finalization || null;
  // Half a cent of float noise is not drift worth showing.
  const gpDrift = Boolean(fin) && Math.abs(fin.margin - margin) >= 0.01;

  // Overpayment is allowed on purpose — a change order raises what the client
  // owes without the contract amount having been updated yet. So this warns
  // and lets you through rather than refusing the entry.
  const cpAmount = Number(cpForm.amount) || 0;
  const cpOverage = cpAmount - clientBalance(job);

  // Over-crediting warns but does not block (Joshua, 2026-11-12): there can be
  // a real reason to post the credit before a payment is corrected.
  const ccAmount = Number(ccForm.amount) || 0;
  const ccBalanceAfter = balance - ccAmount;
  const ccValid = ccAmount > 0 && ccForm.reason.trim() !== "" && Boolean(ccForm.date);

  const submitClientCredit = () => {
    if (!ccValid) return;
    addClientCredit(job.id, {
      amount: ccAmount,
      // Noon local time so the stored instant lands on the chosen day in any
      // US timezone, rather than midnight UTC sliding back to the day before.
      date: new Date(ccForm.date + "T12:00:00").toISOString(),
      reason: ccForm.reason.trim(),
    });
    setCcForm({ amount: "", date: new Date().toISOString().slice(0, 10), reason: "" });
    setCcOpen(false);
  };

  const submitClientPayment = () => {
    if (!cpForm.amount || cpAmount <= 0) return;
    if (cpOverage > 0 && !confirm(
      "This payment puts " + job.customerName + " " + money(cpOverage) +
      " over the " + money(job.contractAmount) + " contract.\n\n" +
      "That's normal after a change order — but if the contract amount should be higher, " +
      "update it first so the margin numbers stay right.\n\nLog the payment anyway?"
    )) return;
    addClientPayment(job.id, {
      amount: cpAmount,
      date: new Date(cpForm.date).toISOString(),
      method: cpForm.method,
      note: cpForm.note.trim(),
      // Blank means the office never touched the dropdown, so fall back to the
      // suggestion rather than filing an unclassified row.
      paymentType: cpForm.paymentType || suggestPaymentType(job, cpAmount),
    });
    setCpForm({ amount: "", date: new Date().toISOString().slice(0, 10), method: cpForm.method, note: "", paymentType: "" });
  };

  // Mirror of the client-payment guard, on the cost side. Margin counts paid
  // and pending together, so this is what the job would actually earn once
  // this cost is booked — pending or not.
  const vpAmount = Number(vpForm.amount) || 0;
  const vpMarginAfter = netContract(job) - (vendorTotal(job) + vpAmount);

  const submitVendorPayment = () => {
    if (!vpForm.vendorName.trim() || !vpForm.amount || vpAmount <= 0) return;
    if (vpMarginAfter < 0 && !confirm(
      "This cost puts " + jobNo(job.number) + " " + money(-vpMarginAfter) +
      " underwater — total costs of " + money(vendorTotal(job) + vpAmount) +
      " against a " + money(job.contractAmount) + " contract.\n\n" +
      "If a change order raised the price, update the contract amount first so " +
      "the margin reports stay honest.\n\nLog the cost anyway?"
    )) return;
    addVendorPayment(job.id, { vendorName: vpForm.vendorName.trim(), category: vpForm.category, amount: vpAmount, date: new Date(vpForm.date).toISOString(), status: vpForm.status, note: vpForm.note.trim() });
    setVpForm({ vendorName: "", category: vpForm.category, amount: "", date: new Date().toISOString().slice(0, 10), status: "pending", note: "" });
  };

  return (
    <Modal title={jobRef(job) + " · " + job.customerName} onClose={onClose} wide
      footer={<>
        {canManage && (
          <button className="td-btn td-btn-danger" onClick={() => { if (confirm("Delete this job? This can't be undone.")) deleteJob(job.id); }}><Trash2 size={13} /> Delete job</button>
        )}
        <div style={{ flex: 1 }} />
        <button className="td-btn td-btn-primary" onClick={() => {
          const next = name.trim();
          const patch = { notes };
          if (next && next !== job.customerName) patch.customerName = next;
          if (phone.trim() !== (job.customerPhone || "")) patch.customerPhone = phone.trim();
          if (email.trim() !== (job.customerEmail || "")) patch.customerEmail = email.trim();
          updateJob(job.id, patch);
          onClose();
        }}>Save & close</button>
      </>}>
      <div className="td-job-detail">

        <div className="td-idline">
          <span className="td-idline-item"><strong>Project #</strong> {job.ghlProjectDisplayId || "— not from GoHighLevel"}</span>
          <span className="td-idline-item"><strong>TradeDesk</strong> {jobNo(job.number)}</span>
        </div>
        {/* Two tiers rather than one row: what the job IS on top as chips, what
            you can CHANGE below as labelled fields. Seven controls in a single
            flex row left every select truncated ("Permitting &", "Needs
            ordere") and wrapped the repair button onto three lines. */}
        <div className="td-deal-head">
          <div className="td-deal-meta">
            <TradeBadge trade={job.trade} />
            {job.substage && <span className="td-substage-chip" title="Stage name from GoHighLevel">{job.substage}</span>}
            {canManage ? (
              <button type="button"
                className={cls("td-hold-toggle", job.isRepair && "active")}
                onClick={() => updateJob(job.id, { isRepair: !job.isRepair })}
                title="Repair work rather than a full replacement">
                <Wrench size={13} /> {job.isRepair ? "Repair" : "Mark as repair"}
              </button>
            ) : (job.isRepair && <span className="td-substage-chip"><Wrench size={12} /> Repair</span>)}
          </div>
          {canManage ? (
          <div className="td-deal-fields">
            <label className="td-deal-field td-deal-field-name">
              <span className="td-field-label">Customer</span>
              <input className="td-input" value={name} placeholder="Customer or site"
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Stage</span>
              <select className="td-select" value={job.stage} onChange={(e) => updateJob(job.id, { stage: e.target.value })}>
                {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Project type</span>
              <select className="td-select" value={job.trade}
                onChange={(e) => updateJob(job.id, { trade: e.target.value })}
                title={isUnknownTrade(job.trade) ? "This project type came from GoHighLevel and isn't in your list yet" : "Project type"}>
                {tradeKeysFor([job]).map((k) => (
                  <option key={k} value={k}>{TRADES[k] ? TRADES[k].label : k + " (unmapped)"}</option>
                ))}
              </select>
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Marker</span>
              <select className={cls("td-select", "td-flag-select", job.flag && "active")}
                value={job.flag || ""}
                onChange={(e) => updateJob(job.id, { flag: e.target.value || null })}
                title="A marker sits alongside the stage and shows in the card corner">
                <option value="">No marker</option>
                {flagKeys().map((k) => <option key={k} value={k}>{JOB_FLAGS[k].label}</option>)}
              </select>
            </label>
            <label className="td-deal-field td-deal-field-amount">
              <span className="td-field-label">Contract amount</span>
              <input className="td-input td-input-num" type="number"
                value={job.contractAmount} onChange={(e) => updateJob(job.id, { contractAmount: Number(e.target.value) })} />
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Contract signed</span>
              {/* Bare YYYY-MM-DD both ways. A date input speaks that natively and
                  the column is a DATE, so nothing converts and nothing shifts. */}
              <input className="td-input" type="date" value={job.contractSignedDate || ""}
                onChange={(e) => updateJob(job.id, { contractSignedDate: e.target.value || null })} />
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Materials ordered</span>
              <input className="td-input" type="date" value={job.materialsOrderedDate || ""}
                onChange={(e) => updateJob(job.id, { materialsOrderedDate: e.target.value || null })} />
            </label>
          </div>
          ) : (
            <ReadOnlyDealFields job={job} />
          )}

          <JobAgeStatus job={job} />
        </div>

        <div className="td-info-row"><Building2 size={14} /> {job.customerAddress}</div>
        {canManage ? (
          <div className="td-info-row td-contact-edit">
            <Phone size={14} />
            <input className="td-input" type="tel" value={phone} placeholder="Phone"
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => commitContact("customerPhone", phone, job.customerPhone)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            <Mail size={14} />
            <input className="td-input" type="email" value={email} placeholder="Email"
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => commitContact("customerEmail", email, job.customerEmail)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          </div>
        ) : (
          <div className="td-info-row"><Phone size={14} /> {job.customerPhone || "—"}<Mail size={14} style={{ marginLeft: 14 }} /> {job.customerEmail || "—"}</div>
        )}

        <JobAssignments ctx={ctx} job={job} />

        <LinkedJobs ctx={ctx} job={job} />

        {canManage && (<>
        <div className="td-payment-summary">
          <div className="td-payment-summary-item">
            <span className="td-field-label">Contract</span>
            <span className="td-payment-summary-value">{moneyDec(job.contractAmount)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Received</span>
            <span className="td-payment-summary-value td-text-green">{moneyDec(received)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Client credits</span>
            <span className={cls("td-payment-summary-value", credited > 0 ? "td-credit-text" : "td-cell-sub")}>{credited > 0 ? creditMoney(credited) : "$0.00"}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Balance due</span>
            <span className={cls("td-payment-summary-value", balance > 0 && "td-text-red")}>{signedMoneyDec(balance)}</span>
            {isPaidInFull(job) && balance > -0.005 && <span className="td-cell-sub td-text-green"><Check size={11} style={{ verticalAlign: -1 }} /> Paid in full</span>}
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Vendor costs owed</span>
            <span className={cls("td-payment-summary-value", vPending > 0 && "td-text-red")}>{money(vPending)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">{fin ? "Final GP" : "Margin"}</span>
            <span className={cls("td-payment-summary-value", (fin ? fin.margin : margin) < 0 && "td-text-red")}>
              {money(fin ? fin.margin : margin)} <span className="td-cell-sub">({pct(fin ? fin.marginPct : marginPercent)})</span>
            </span>
            {/* The frozen number is the one of record. When later costs have
                moved the live figure the two are shown together, because a
                silent gap between what was reported and what the job now says
                is the thing finalizing was meant to prevent. */}
            {gpDrift && <span className="td-gp-drift" title="Costs have changed since this was finalized">live {money(margin)}</span>}
          </div>
        </div>
        <ProgressBar value={paidPct(job)} tone={balance <= 0 ? "green" : undefined} />

        {isPaidInFull(job) && (
          <div className="td-paidstatus">
            <span className="td-field-label">Paid in full — this job is</span>
            <div className="td-paidstatus-opts" role="radiogroup" aria-label="Paid in full status">
              {Object.entries(PAID_STATUSES).map(([key, s]) => (
                <button key={key} type="button" role="radio" aria-checked={job.paidStatus === key}
                  className={cls("td-hold-toggle", job.paidStatus === key && "td-paidstatus-on")}
                  onClick={() => updateJob(job.id, { paidStatus: job.paidStatus === key ? "" : key })}>
                  <Check size={13} /> {s.label}
                </button>
              ))}
            </div>
            {!job.paidStatus && <span className="td-cell-sub">Not chosen yet — the card shows a plain "Paid in full" tag until you pick one.</span>}
          </div>
        )}

        <JobGpFinalize ctx={ctx} job={job} liveMargin={margin} drifted={gpDrift} />

        <div className="td-job-detail-cols">
          <div className="td-job-detail-col">
            <div className="td-drawer-section-title" style={{ borderTop: "none", paddingTop: 0 }}>Client payments</div>
            {(job.clientPayments || []).length === 0 && (job.clientCredits || []).length === 0 ? <div className="td-muted-line">No payments logged yet.</div> : (
              <div className="td-payment-list">
                {[...(job.clientPayments || []).map((p) => ({ ...p, _kind: "payment" })),
                  ...(job.clientCredits || []).map((c) => ({ ...c, _kind: "credit" }))]
                  .sort((a, b) => new Date(b.date) - new Date(a.date)).map((p) => p._kind === "credit" ? (
                  <div key={"cc-" + p.id} className="td-payment-row td-credit-row">
                    <div className="td-payment-row-main">
                      <div className="td-payment-row-top">
                        <span className="td-payment-amount td-credit-text">{creditMoney(p.amount)}</span>
                        <span className="td-paytype-chip td-credit-chip">Client credit</span>
                      </div>
                      <div className="td-cell-sub">{fmtDate(p.date)}{p.reason ? " \u00b7 \u201c" + p.reason + "\u201d" : ""}</div>
                    </div>
                    <button className="td-iconbtn td-iconbtn-danger" onClick={() => {
                      if (confirm("Delete this " + creditMoney(p.amount) + " client credit" + (p.reason ? " (\u201c" + p.reason + "\u201d)" : "") + "? The balance due will go back up by " + moneyDec(p.amount) + ".")) deleteClientCredit(job.id, p.id);
                    }} aria-label="Delete client credit"><Trash2 size={12} /></button>
                  </div>
                ) : (
                  <div key={p.id} className="td-payment-row">
                    <div className="td-payment-row-main">
                      <div className="td-payment-row-top">
                        <span className="td-payment-amount td-text-green">{moneyDec(p.amount)}</span>
                        <span className="td-paytype-chip">{paymentTypeLabel(p.paymentType)}</span>
                        <span className="td-cell-sub">{p.method}</span>
                        {p.sourceRef && <span className="td-ghl-badge" title="Kept in step with the CRM — editing it here will be overwritten on the next update">ADDED BY GHL</span>}
                      </div>
                      <div className="td-cell-sub">
                        {fmtDate(p.date)}
                        {/* The badge already says it came from GHL, so the
                            prefix the mapper writes into the note is redundant here. */}
                        {(() => { const n = (p.note || "").replace(/^ADDED BY GHL — ?/, ""); return n ? " · " + n : ""; })()}
                      </div>
                    </div>
                    <button className="td-iconbtn td-iconbtn-danger" onClick={() => {
                      const msg = p.sourceRef
                        ? "Delete this " + money(p.amount) + " payment? It came from GoHighLevel, so the next update for this job will put it back — clear the field in the CRM instead if it shouldn't be there."
                        : "Delete this " + money(p.amount) + " client payment? The balance due will go back up.";
                      if (confirm(msg)) deleteClientPayment(job.id, p.id);
                    }} aria-label="Delete payment"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="td-payment-form">
              <div className="td-payment-form-row">
                <input className="td-input td-input-num" type="number" placeholder="Amount" value={cpForm.amount} onChange={(e) => setCpForm((f) => ({ ...f, amount: e.target.value }))} />
                <input className="td-input" type="date" value={cpForm.date} onChange={(e) => setCpForm((f) => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="td-payment-form-row">
                {/* What the money WAS (deposit, final) as well as how it arrived
                    (check, financing). The reports group by the first. */}
                <select className="td-select" value={cpForm.paymentType || suggestPaymentType(job, cpAmount)}
                  onChange={(e) => setCpForm((f) => ({ ...f, paymentType: e.target.value }))}
                  title="What this payment is. Suggested from the job's history — change it if that's wrong.">
                  {paymentTypeKeys().map((k) => <option key={k} value={k}>{PAYMENT_TYPES[k].label}</option>)}
                </select>
                <select className="td-select" value={cpForm.method} onChange={(e) => setCpForm((f) => ({ ...f, method: e.target.value }))}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="td-payment-form-row">
                <input className="td-input" placeholder="Note (optional)" value={cpForm.note} onChange={(e) => setCpForm((f) => ({ ...f, note: e.target.value }))} />
              </div>
              {cpOverage > 0 && (
                <div className="td-overage-hint">
                  <AlertTriangle size={13} />
                  <span>{money(cpOverage)} more than the balance due — the job would show a {money(cpOverage)} overpayment.</span>
                </div>
              )}
              <div className="td-payment-btns">
                <button className="td-btn td-btn-primary td-btn-sm" onClick={submitClientPayment}><Plus size={13} /> Log client payment</button>
                {!ccOpen && (
                  <button className="td-btn td-btn-sm td-credit-btn" onClick={() => setCcOpen(true)}
                    title="Take money off what the client owes. The contract amount stays as signed.">
                    <Minus size={13} /> Apply credit
                  </button>
                )}
              </div>
            </div>
            {ccOpen && (
              <div className="td-payment-form td-credit-form">
                <div className="td-credit-form-title">Apply client credit</div>
                <div className="td-payment-form-row">
                  <input className="td-input td-input-num" type="number" min="0" step="0.01" placeholder="Credit amount" autoFocus
                    value={ccForm.amount} onChange={(e) => setCcForm((f) => ({ ...f, amount: e.target.value }))} />
                  <input className="td-input" type="date" value={ccForm.date} onChange={(e) => setCcForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <input className="td-input" placeholder="Reason (required) — e.g. Gutter color change" value={ccForm.reason}
                  onChange={(e) => setCcForm((f) => ({ ...f, reason: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitClientCredit(); }} />
                {ccAmount > 0 && (
                  <div className="td-cell-sub">Balance will go from <strong>{signedMoneyDec(balance)}</strong> to <strong>{signedMoneyDec(ccBalanceAfter)}</strong>.</div>
                )}
                {ccAmount > 0 && ccBalanceAfter <= -0.005 && (
                  <div className="td-overage-hint">
                    <AlertTriangle size={13} />
                    <span>This leaves a {signedMoneyDec(ccBalanceAfter)} balance. Credits aren't refunds — check the amount.</span>
                  </div>
                )}
                <div className="td-payment-btns">
                  <button className="td-btn td-btn-sm td-credit-btn td-credit-btn-solid" disabled={!ccValid} onClick={submitClientCredit}
                    title={ccValid ? "" : "Enter an amount above $0 and a reason"}>
                    <Check size={13} /> Apply credit
                  </button>
                  <button className="td-btn td-btn-sm" onClick={() => { setCcOpen(false); setCcForm({ amount: "", date: new Date().toISOString().slice(0, 10), reason: "" }); }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div className="td-job-detail-col">
            <div className="td-drawer-section-title" style={{ borderTop: "none", paddingTop: 0 }}>Vendor payments</div>
            {(job.vendorPayments || []).length === 0 ? <div className="td-muted-line">No vendor costs logged yet.</div> : (
              <div className="td-payment-list">
                {[...job.vendorPayments].sort((a, b) => new Date(b.date) - new Date(a.date)).map((p) => (
                  <div key={p.id} className="td-payment-row">
                    <div className="td-payment-row-main">
                      <div className="td-payment-row-top">
                        <span className="td-payment-amount">{moneyDec(p.amount)}</span>
                        <span className="td-cell-sub">{p.vendorName}</span>
                      </div>
                      <div className="td-cell-sub">{p.category} · {fmtDate(p.date)}{p.note ? " · " + p.note : ""}</div>
                    </div>
                    <button className={cls("td-toggle-chip", p.status === "paid" && "active")} style={{ padding: "4px 8px", fontSize: 11 }}
                      onClick={() => updateVendorPayment(job.id, p.id, { status: p.status === "paid" ? "pending" : "paid" })}>
                      {p.status === "paid" ? <><Check size={11} /> Paid</> : "Pending"}
                    </button>
                    <button className="td-iconbtn td-iconbtn-danger" onClick={() => { if (confirm("Delete this " + money(p.amount) + " payment to " + p.vendorName + "?")) deleteVendorPayment(job.id, p.id); }} aria-label="Delete"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="td-payment-form">
              <div className="td-payment-form-row">
                <input className="td-input" list="vendor-name-options" placeholder="Vendor name" value={vpForm.vendorName} onChange={(e) => setVpForm((f) => ({ ...f, vendorName: e.target.value }))} />
                <input className="td-input td-input-num" type="number" placeholder="Amount" value={vpForm.amount} onChange={(e) => setVpForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <datalist id="vendor-name-options">
                {vendorNames.map((n) => <option key={n} value={n} />)}
              </datalist>
              <div className="td-payment-form-row">
                <select className="td-select" value={vpForm.category} onChange={(e) => setVpForm((f) => ({ ...f, category: e.target.value }))}>
                  {VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="td-input" type="date" value={vpForm.date} onChange={(e) => setVpForm((f) => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="td-payment-form-row">
                <select className="td-select" value={vpForm.status} onChange={(e) => setVpForm((f) => ({ ...f, status: e.target.value }))}>
                  <option value="pending">Pending (owed)</option>
                  <option value="paid">Paid</option>
                </select>
                <input className="td-input" placeholder="Note (optional)" value={vpForm.note} onChange={(e) => setVpForm((f) => ({ ...f, note: e.target.value }))} />
              </div>
              {vpAmount > 0 && vpMarginAfter < 0 && (
                <div className="td-overage-hint td-overage-hint-loss">
                  <AlertTriangle size={13} />
                  <span>Costs would reach {money(vendorTotal(job) + vpAmount)} against a {money(job.contractAmount)} contract — a {money(-vpMarginAfter)} loss.</span>
                </div>
              )}
              <button className="td-btn td-btn-primary td-btn-sm" onClick={submitVendorPayment}><Plus size={13} /> Log vendor cost</button>
            </div>
          </div>
        </div>
        </>)}

        <Field label="Job notes">
          <textarea className="td-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Site access notes, material changes, punch list items…" />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Finalize GP — the moment the office declares a job's gross profit final.
 *
 * Finalizing always records the snapshot. Whether it also emails is a separate
 * question answered in the database, and it goes out in two cases: the gross
 * profit came in under the threshold in email_config, or the figure moved
 * since the last finalization. A healthy job is finalized silently, but once a
 * number has been stated, any correction to it is stated too.
 *
 * Margin is otherwise a live calculation that moves every time a vendor bill
 * is entered, so there is no natural instant at which it is "the" number.
 * This button creates one: it freezes the figure, records who froze it and
 * when, and emails it out. A bill that arrives afterwards does not rewrite
 * history — it shows up as drift against the frozen figure, and re-finalizing
 * sends a clearly marked revision rather than quietly replacing the first.
 *
 * Office-only, like every other money control on this card. finalize_job_gp()
 * checks is_admin() in Postgres; this only decides what gets drawn.
 */
function JobGpFinalize({ ctx, job, liveMargin, drifted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState("");
  const fin = job.finalization || null;

  const run = async () => {
    if (busy) return;
    const again = Boolean(fin);
    if (!confirm(
      again
        ? "Re-finalize " + jobRef(job) + " at " + money(liveMargin) + "?\n\n" +
          "The gross profit on record becomes " + money(liveMargin) + ", was " + money(fin.margin) + "."
        : "Finalize " + jobRef(job) + " at a gross profit of " + money(liveMargin) + "?\n\n" +
          "This freezes the figure. Costs entered later will show as drift against it rather " +
          "than changing it."
    )) return;

    setBusy(true); setErr(""); setSent("");
    try {
      const res = await repo.finalizeGp(job.id);
      const to = (res && res.recipients) || [];
      if (res && res.queued) {
        const why = res.reason === "gp_changed"
          ? "the figure changed"
          : "gross profit is under " + Math.round(Number(res.threshold_margin_pct || 0) * 100) + "%";
        setSent("Finalized. Emailed to " + to.join(", ") + " — " + why + ".");
      } else if (res && !res.reason) {
        // Not a failure, and worth saying out loud: silence here is the
        // feature, not a send that went missing.
        const t = Math.round(Number(res.threshold_margin_pct || 0) * 100);
        setSent("Finalized. No email — gross profit is at or above " + t + "% and nothing changed.");
      } else {
        setSent("Finalized, but no active recipient is configured — nothing was emailed.");
      }
      await ctx.reload();
    } catch (e) {
      setErr(e && e.message ? e.message : "The finalization was refused.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="td-gp-final">
      <div className="td-gp-final-main">
        {fin ? (
          <>
            <span className="td-gp-badge"><Lock size={11} /> Final GP {money(fin.margin)}</span>
            <span className="td-gp-when">
              finalized {fmtDate(fin.finalizedAt)}{fin.seq > 1 ? " · revision " + fin.seq : ""}
            </span>
          </>
        ) : (
          <span className="td-gp-when">
            Gross profit is still live — it moves with every cost entered. Finalizing freezes
            it, and emails ownership if it comes in thin or if a frozen figure later changes.
          </span>
        )}
        {drifted && (
          <span className="td-gp-drift-note">
            <AlertTriangle size={11} /> costs have changed since — now {money(liveMargin)}
          </span>
        )}
      </div>
      <button type="button" className={cls("td-btn", "td-btn-sm", !fin && "td-btn-primary")}
        onClick={run} disabled={busy}>
        {busy ? <RefreshCw size={13} className="td-spin" /> : <Send size={13} />}
        {fin ? " Re-finalize GP" : " Finalize GP"}
      </button>
      {(err || sent) && (
        <div className={cls("td-gp-msg", err && "td-gp-msg-err")}>{err || sent}</div>
      )}
    </div>
  );
}

/**
 * What a project manager sees where the editable fields sit for everyone else.
 *
 * The contract amount is here on purpose — knowing what the job is worth is
 * part of running it. Everything else on this card that is money (what has
 * been received, what the vendors are owed, the margin) is not shown to them
 * at all, and is not sent to the browser in the first place.
 */
function ReadOnlyDealFields({ job }) {
  const stage = STAGES.find((s) => s.key === job.stage);
  const trade = TRADES[job.trade];
  return (
    <div className="td-deal-fields td-deal-ro">
      <div className="td-deal-field">
        <span className="td-field-label">Stage</span>
        <span className="td-deal-ro-value">{stage ? stage.label : job.stage}</span>
      </div>
      <div className="td-deal-field">
        <span className="td-field-label">Project type</span>
        <span className="td-deal-ro-value">{trade ? trade.label : job.trade}</span>
      </div>
      <div className="td-deal-field td-deal-field-amount">
        <span className="td-field-label">Contract amount</span>
        <span className="td-deal-ro-value">{money(job.contractAmount)}</span>
      </div>
      <div className="td-deal-field">
        <span className="td-field-label">Contract signed</span>
        <span className="td-deal-ro-value">{job.contractSignedDate ? fmtDateNum(job.contractSignedDate) : "—"}</span>
      </div>
      <div className="td-deal-field">
        <span className="td-field-label">Materials ordered</span>
        <span className="td-deal-ro-value">{job.materialsOrderedDate ? fmtDateNum(job.materialsOrderedDate) : "—"}</span>
      </div>
    </div>
  );
}

/* =========================================================================
   ASSIGNMENTS — who is on this job, and when
   -------------------------------------------------------------------------
   One section per role from the registry. Each is a list rather than a single
   value: two installers in different weeks, or a second trade back for a punch
   list, is ordinary rather than exceptional.

   Roles the registry marks `scheduled` carry a date range and reach the
   calendar. The project manager does not — owning a job is not a booking.
   ========================================================================= */

function JobAssignments({ ctx, job }) {
  return (
    <div className="td-assign">
      {assigneeRoleKeys().map((roleKey) => (
        <AssignmentRole key={roleKey} ctx={ctx} job={job} roleKey={roleKey} />
      ))}
    </div>
  );
}

function AssignmentRole({ ctx, job, roleKey }) {
  const { assignees, assigneeById, addAssignment, updateAssignment, removeAssignment } = ctx;
  // Who is on a job is the office's call. A project manager can move the dates
  // of a crew already booked — that is the whole point of giving them the
  // calendar — but cannot put someone on a job or take them off it.
  const canManage = ctx.isAdmin;
  const role = assigneeRole(roleKey);
  const [pick, setPick] = useState("");
  const [newName, setNewName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = (job.assignments || []).filter((a) => a.role === roleKey);
  // Retired people stay resolvable for rows they are already on, but they are
  // not offered for new ones.
  const options = assignees.filter((a) => a.role === roleKey && a.active);

  const writingIn = pick === "__new";
  const canAdd = writingIn ? Boolean(newName.trim()) : Boolean(pick);

  const submit = async () => {
    if (!canAdd || busy) return;
    setBusy(true);
    await addAssignment({
      jobId: job.id,
      role: roleKey,
      assigneeId: writingIn ? null : pick,
      name: writingIn ? newName : "",
      startDate: role.scheduled ? (start || null) : null,
      endDate: role.scheduled ? (end || null) : null,
    });
    setBusy(false);
    setPick("");
    setNewName("");
    setStart("");
    setEnd("");
  };

  return (
    <div className="td-assign-role">
      <div className="td-assign-role-head">
        <span className="td-field-label">{role.label}</span>
        {!role.scheduled && <span className="td-assign-note">no dates — not on the calendar</span>}
      </div>

      {rows.length === 0 ? (
        <div className="td-muted-line">Nobody assigned.</div>
      ) : (
        rows.map((a) => (
          <AssignmentRow key={a.id} a={a} person={assigneeById.get(a.assigneeId)}
            scheduled={role.scheduled} canManage={canManage}
            onChange={(patch) => updateAssignment(job.id, a.id, patch)}
            onRemove={() => {
              const who = (assigneeById.get(a.assigneeId) || {}).name || "this person";
              if (confirm("Take " + who + " off " + jobRef(job) + "?")) removeAssignment(job.id, a.id);
            }} />
        ))
      )}

      {canManage && (
      <div className="td-assign-add">
        <select className="td-select" value={pick}
          onChange={(e) => { setPick(e.target.value); if (e.target.value !== "__new") setNewName(""); }}>
          <option value="">Assign {role.label.toLowerCase()}…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          {/* A write-in is saved as a person, so it is in this list next time —
              which is the only way a dropdown stays useful without someone
              having to maintain it. */}
          <option value="__new">+ Add a new name…</option>
        </select>
        {writingIn && (
          <input className="td-input" placeholder="Name" value={newName} autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        )}
        {role.scheduled && (
          <>
            <input className="td-input td-assign-date" type="date" value={start} title="Start"
              onChange={(e) => setStart(e.target.value)} />
            <span className="td-assign-dash">–</span>
            <input className="td-input td-assign-date" type="date" value={end} title="End"
              min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </>
        )}
        <button className="td-btn td-btn-sm" onClick={submit} disabled={!canAdd || busy}>
          {busy ? <RefreshCw size={13} className="td-spin" /> : <UserPlus size={13} />} Add
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * One assigned person. The dates read as mm/dd/yy and only turn into pickers
 * when clicked — two date inputs sitting open on every row turned a job with
 * four people on it into a wall of grey boxes.
 */
function AssignmentRow({ a, person, scheduled, canManage, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  const label = fmtDateRange(a.startDate, a.endDate);
  const color = (person && person.color) || "#4A6070";

  return (
    <div className="td-assign-row">
      <span className="td-assign-chip" style={{ background: color, color: textOn(color) }}>
        {person ? person.name : "Unknown person"}
        {person && person.active === false && <span className="td-assign-retired" title="No longer on the list">·</span>}
      </span>

      {scheduled && (editing ? (
        <>
          <input className="td-input td-assign-date" type="date" value={a.startDate || ""} autoFocus
            onChange={(e) => onChange({ startDate: e.target.value || null })} />
          <span className="td-assign-dash">–</span>
          <input className="td-input td-assign-date" type="date" value={a.endDate || ""}
            min={a.startDate || undefined}
            onChange={(e) => onChange({ endDate: e.target.value || null })} />
          <button className="td-btn td-btn-sm td-btn-ghost" onClick={() => setEditing(false)}>Done</button>
        </>
      ) : (
        <button className={cls("td-assign-dates", !label && "td-assign-dates-empty")}
          onClick={() => setEditing(true)}
          title="Click to set the date range">
          <CalendarIcon size={12} /> {label || "Set dates"}
        </button>
      ))}

      <div style={{ flex: 1 }} />
      {canManage && <IconBtn icon={Trash2} danger title="Remove from this job" onClick={onRemove} />}
    </div>
  );
}

/* =========================================================================
   VENDORS
   ========================================================================= */

function VendorsView({ ctx }) {
  const { vendors, vendorSpend, setShowVendorForm, deleteVendor, search } = ctx;
  const filtered = vendors.filter((v) => !search || v.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="td-view">
      <div className="td-toolbar">
        <div />
        <button className="td-btn td-btn-primary" onClick={() => setShowVendorForm(true)}><Plus size={15} /> Add vendor</button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Truck} title="No vendors yet" sub="Add the material suppliers and subcontractors you pay on jobs." />
      ) : (
        <div className="td-table-wrap">
          <table className="td-table">
            <thead><tr><th>Vendor</th><th>Category</th><th># of Contracts</th><th>Total Paid</th><th>Total Owed</th><th></th></tr></thead>
            <tbody>
              {filtered.map((v) => {
                const spend = vendorSpend[v.name] || { paid: 0, pending: 0, jobCount: 0 };
                return (
                  <tr key={v.id} className="td-table-row" onClick={() => setShowVendorForm(v)}>
                    <td className="td-cell-name">{v.name}</td>
                    <td className="td-cell-sub">{v.category}</td>
                    {/* Jobs this vendor has a logged payment on — a vendor in the
                        directory with nothing booked against them yet reads 0. */}
                    <td>{spend.jobCount}</td>
                    <td>{money(spend.paid)}</td>
                    <td className={spend.pending > 0 ? "td-text-red" : "td-cell-sub"}>{spend.pending > 0 ? money(spend.pending) : "—"}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="td-iconbtn td-iconbtn-danger" onClick={() => { if (confirm("Remove " + v.name + " from your vendor directory? Past payments logged on jobs stay untouched.")) deleteVendor(v.id); }} aria-label="Delete vendor"><Trash2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VendorFormModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState(initial || { name: "", category: VENDOR_CATEGORIES[0], phone: "", email: "", notes: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = form.name.trim();

  return (
    <Modal title={initial ? "Edit vendor" : "New vendor"} onClose={onClose}
      footer={<>
        <button className="td-btn" onClick={onClose}>Cancel</button>
        <button className="td-btn td-btn-primary" disabled={!valid} onClick={() => valid && onSave(form)}>Save vendor</button>
      </>}>
      <div className="td-form-grid">
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Vendor / company name"><input className="td-input" value={form.name} onChange={set("name")} placeholder="Ridgeline Roofing Supply" /></Field>
        </div>
        <Field label="Category">
          <select className="td-select td-select-full" value={form.category} onChange={set("category")}>
            {VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Phone"><input className="td-input" value={form.phone} onChange={set("phone")} placeholder="412-555-0100" /></Field>
        <Field label="Email"><input className="td-input" value={form.email} onChange={set("email")} placeholder="orders@vendor.example" /></Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Notes"><textarea className="td-textarea" rows={2} value={form.notes} onChange={set("notes")} placeholder="Lead times, account number, terms…" /></Field>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Ageing status for one job: how long each clock has been running, which rules
 * have tripped, and — the part the office actually needs — a prompt for any
 * date that is missing while its rule could still apply. An undated job is not
 * a job that is on time; it is a job nobody is measuring.
 */
function JobAgeStatus({ job }) {
  const tripped = ageFlags(job);
  const gaps = ageDateGaps(job);
  const scheduled = stageIndex(job.stage) >= stageIndex("scheduled");
  const counters = ageRuleKeys()
    .map((k) => ({ key: k, ...AGE_RULES[k] }))
    .map((r) => ({ ...r, weeksElapsed: weeksSince(job[r.field]) }))
    .filter((r) => r.weeksElapsed !== null);

  if (!counters.length && !gaps.length) return null;

  return (
    <div className={cls("td-age-panel", tripped.length && "td-age-panel-hot")}>
      {counters.map((r) => {
        const hit = tripped.find((t) => t.key === r.key);
        return (
          <div key={r.key} className="td-age-item">
            <span className="td-field-label">
              {r.field === "materialsOrderedDate" ? "Since materials ordered" : "Since contract signed"}
            </span>
            <strong className={hit ? "td-text-red" : undefined}>
              {hit && <span className="td-age-emoji">{r.emoji} </span>}
              {r.weeksElapsed}w
            </strong>
            <span className="td-cell-sub">
              {hit ? "past the " + r.weeks + "w mark"
                   : scheduled ? "clock stopped at Scheduled"
                   : r.weeks - r.weeksElapsed + "w before it flags"}
            </span>
          </div>
        );
      })}
      {gaps.map((r) => (
        <div key={r.key} className="td-age-gap">
          <AlertTriangle size={13} /> <span>{r.prompt}</span>
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   REPORTS — transaction reporting
   -------------------------------------------------------------------------
   The dashboard below answers "where do we stand right now". This part answers
   "what happened between these two dates", which is a different question and
   needs a different shape: every payment row is a fact with a date, and the
   report is a filter plus a grouping over those facts.

   Both ledgers are folded into one row type so a single filter, a single
   grouping and a single export can serve client money in and vendor money out.
   ========================================================================= */

/**
 * One parser for every date the reports touch, because they arrive in two
 * shapes and the difference is not cosmetic:
 *
 *   "2026-09-07"                 a date input. Parsed bare it is read as UTC,
 *                                which in every US timezone lands on the 6th —
 *                                so a payment on the 1st would fall into the
 *                                previous month's report. Pinned to LOCAL
 *                                midnight instead.
 *   "2026-09-07T14:23:00.000Z"   a stored payment timestamp. Already absolute;
 *                                hand it to Date untouched.
 *
 * Returns null rather than an Invalid Date, so a bad value is something callers
 * must handle instead of a RangeError thrown deep inside a render.
 */
const parseDate = (v) => {
  if (v === null || v === undefined || v === "") return null;
  let d;
  if (v instanceof Date) d = new Date(v.getTime());
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) d = new Date(v + "T00:00:00");
  else d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const dayStart = (v) => { const d = parseDate(v); if (!d) return null; d.setHours(0, 0, 0, 0); return d; };
const dayEnd = (v) => { const d = dayStart(v); if (!d) return null; d.setHours(23, 59, 59, 999); return d; };
const isoDay = (v) => {
  const d = parseDate(v);
  if (!d) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const addDaysTo = (v, n) => { const d = parseDate(v); if (!d) return null; d.setDate(d.getDate() + n); return d; };

/** Monday-start weeks: the office thinks in work weeks, not Sunday weeks. */
const startOfWeek = (v) => {
  const d = dayStart(v);
  if (!d) return null;
  return addDaysTo(d, -((d.getDay() + 6) % 7));
};
const startOfMonth = (v) => { const d = dayStart(v); if (!d) return null; d.setDate(1); return d; };
const startOfQuarter = (v) => {
  const d = startOfMonth(v);
  if (!d) return null;
  d.setMonth(Math.floor(d.getMonth() / 3) * 3);
  return d;
};
const startOfYear = (v) => { const d = startOfMonth(v); if (!d) return null; d.setMonth(0); return d; };

/** Named ranges. Each returns [from, to] as date-only strings. */
const DATE_PRESETS = {
  this_week:    { label: "This week",     range: () => [startOfWeek(new Date()), new Date()] },
  last_week:    { label: "Last week",     range: () => { const s = addDaysTo(startOfWeek(new Date()), -7); return [s, addDaysTo(s, 6)]; } },
  this_month:   { label: "This month",    range: () => [startOfMonth(new Date()), new Date()] },
  last_month:   { label: "Last month",    range: () => { const s = startOfMonth(new Date()); s.setMonth(s.getMonth() - 1); const e = startOfMonth(new Date()); return [s, addDaysTo(e, -1)]; } },
  last_30:      { label: "Last 30 days",  range: () => [addDaysTo(new Date(), -29), new Date()] },
  last_90:      { label: "Last 90 days",  range: () => [addDaysTo(new Date(), -89), new Date()] },
  this_quarter: { label: "This quarter",  range: () => [startOfQuarter(new Date()), new Date()] },
  ytd:          { label: "Year to date",  range: () => [startOfYear(new Date()), new Date()] },
  last_year:    { label: "Last year",     range: () => { const s = startOfYear(new Date()); s.setFullYear(s.getFullYear() - 1); const e = startOfYear(new Date()); return [s, addDaysTo(e, -1)]; } },
  all:          { label: "All time",      range: () => [new Date(2000, 0, 1), new Date()] },
  custom:       { label: "Custom range…", range: null },
};

/**
 * Every key function receives the row's already-parsed Date as `when`, so the
 * grouping pass never re-parses and never meets a bad value — rows without a
 * usable date are dropped when the ledger is flattened, not here.
 */
const GROUPINGS = {
  none:    { label: "No grouping", key: () => "All" },
  day:     { label: "By day",      key: (when) => isoDay(dayStart(when)) },
  week:    { label: "By week",     key: (when) => isoDay(startOfWeek(when)) },
  month:   { label: "By month",    key: (when) => isoDay(startOfMonth(when)) },
  quarter: { label: "By quarter",  key: (when) => isoDay(startOfQuarter(when)) },
  year:    { label: "By year",     key: (when) => isoDay(startOfYear(when)) },
  type:    { label: "By payment type", key: (when, r) => r.typeLabel },
  method:  { label: "By method",   key: (when, r) => r.method || "—" },
  trade:   { label: "By trade",    key: (when, r) => r.tradeLabel },
  customer:{ label: "By customer", key: (when, r) => r.customer || "—" },
  vendor:  { label: "By vendor",   key: (when, r) => r.vendor || "—" },
};

/** How a group key reads once grouped — "2026-09-07" means little on its own. */
function groupLabel(groupBy, key) {
  const d = dayStart(key);
  if (!d) return key || "—";
  if (groupBy === "week") return "Week of " + d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (groupBy === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (groupBy === "quarter") return "Q" + (Math.floor(d.getMonth() / 3) + 1) + " " + d.getFullYear();
  if (groupBy === "year") return String(d.getFullYear());
  if (groupBy === "day") return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return key;
}

/**
 * Flatten the ledgers into one list of comparable rows. Direction is what
 * keeps them straight: client payments are money in, vendor costs money out,
 * and client credits are "credit" — money taken off what a client owes. A
 * credit is not cash, so it never feeds Money in, Money out or Net; it is
 * totalled on its own as Credits applied.
 *
 * The date is parsed ONCE here, into `when`. A payment whose date will not
 * parse is counted and left out rather than carried forward — a date-less row
 * cannot belong to any period, and letting one reach the grouping pass is what
 * turned this whole page blank on 2026-09-23.
 */
function buildLedgerRows(jobs) {
  const rows = [];
  let undated = 0;
  const push = (row) => {
    const when = parseDate(row.date);
    if (!when) { undated += 1; return; }
    rows.push({ ...row, when });
  };
  jobs.forEach((j) => {
    const tradeLabel = TRADES[j.trade] ? TRADES[j.trade].label : (j.trade || "—");
    const stageLabel = (STAGES.find((s) => s.key === j.stage) || {}).label || j.stage;
    (j.clientPayments || []).forEach((p) => push({
      id: p.id, direction: "in", ledger: "Client payment",
      date: p.date, amount: Number(p.amount || 0),
      typeKey: p.paymentType || null, typeLabel: paymentTypeLabel(p.paymentType),
      method: p.method || "", vendor: "", category: "", status: "received",
      jobNumber: j.number, projectRef: j.ghlProjectDisplayId || "",
      customer: j.customerName, address: j.customerAddress || "",
      tradeKey: j.trade, tradeLabel, stageKey: j.stage, stageLabel,
      fromCrm: Boolean(p.sourceRef), note: (p.note || "").replace(/^ADDED BY GHL — ?/, ""),
    }));
    (j.vendorPayments || []).forEach((p) => push({
      id: p.id, direction: "out", ledger: "Vendor cost",
      date: p.date, amount: Number(p.amount || 0),
      typeKey: null, typeLabel: p.category || "—",
      method: "", vendor: p.vendorName || "", category: p.category || "",
      status: p.status || "pending",
      jobNumber: j.number, projectRef: j.ghlProjectDisplayId || "",
      customer: j.customerName, address: j.customerAddress || "",
      tradeKey: j.trade, tradeLabel, stageKey: j.stage, stageLabel,
      fromCrm: false, note: p.note || "",
    }));
    (j.clientCredits || []).forEach((c) => push({
      id: c.id, direction: "credit", ledger: "Client credit",
      date: c.date, amount: Number(c.amount || 0),
      typeKey: null, typeLabel: "Client credit",
      method: "", vendor: "", category: "", status: "applied",
      jobNumber: j.number, projectRef: j.ghlProjectDisplayId || "",
      customer: j.customerName, address: j.customerAddress || "",
      tradeKey: j.trade, tradeLabel, stageKey: j.stage, stageLabel,
      fromCrm: false, note: c.reason || "",
    }));
  });
  return { rows, undated };
}

/* ---- export ---------------------------------------------------------- */

const EXPORT_COLUMNS = [
  { key: "date",       header: "Date",          money: false },
  { key: "ledger",     header: "Ledger",        money: false },
  { key: "typeLabel",  header: "Type",          money: false },
  { key: "amount",     header: "Amount",        money: true },
  { key: "method",     header: "Method",        money: false },
  { key: "vendor",     header: "Vendor",        money: false },
  { key: "status",     header: "Status",        money: false },
  { key: "jobNumber",  header: "Job #",         money: false },
  { key: "projectRef", header: "Project #",     money: false },
  { key: "customer",   header: "Customer",      money: false },
  { key: "address",    header: "Address",       money: false },
  { key: "tradeLabel", header: "Trade",         money: false },
  { key: "stageLabel", header: "Stage",         money: false },
  { key: "note",       header: "Note",          money: false },
];

const exportValue = (r, col) => (col.key === "date" ? isoDay(r.date) : (r[col.key] ?? ""));

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  // Revoked on the next tick: Safari cancels the download if the URL dies first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv(rows, filename) {
  // Excel reads a leading = + - @ as a formula, so a note starting with one is
  // an injection risk in someone else's spreadsheet. Prefix with a quote.
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [EXPORT_COLUMNS.map((c) => cell(c.header)).join(",")];
  rows.forEach((r) => lines.push(EXPORT_COLUMNS.map((c) => cell(exportValue(r, c))).join(",")));
  // BOM so Excel opens UTF-8 correctly on Windows.
  downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }), filename);
}

/**
 * Loaded on demand. The sheet writer is far larger than the rest of the app,
 * and most sessions never export — so it stays out of the main bundle.
 */
async function exportXlsx(rows, filename, summary) {
  const XLSX = await import("xlsx");
  const aoa = [EXPORT_COLUMNS.map((c) => c.header)];
  rows.forEach((r) => aoa.push(EXPORT_COLUMNS.map((c) => {
    const v = exportValue(r, c);
    return c.money ? Number(v || 0) : v;
  })));
  // Totals per ledger, so each figure in the sheet matches one on screen.
  // Adding payments, costs and credits into a single sum would mean nothing.
  const sumOf = (dir) => rows.filter((r) => r.direction === dir).reduce((s, r) => s + Number(r.amount || 0), 0);
  aoa.push([]);
  if (rows.some((r) => r.direction === "in")) aoa.push(["TOTAL MONEY IN", "", "", sumOf("in")]);
  if (rows.some((r) => r.direction === "out")) aoa.push(["TOTAL MONEY OUT", "", "", sumOf("out")]);
  if (rows.some((r) => r.direction === "credit")) aoa.push(["TOTAL CREDITS APPLIED", "", "", sumOf("credit")]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const amountCol = EXPORT_COLUMNS.findIndex((c) => c.money);
  for (let i = 1; i < aoa.length; i++) {
    const ref = XLSX.utils.encode_cell({ r: i, c: amountCol });
    if (ws[ref] && typeof ws[ref].v === "number") ws[ref].z = '"$"#,##0.00';
  }
  ws["!cols"] = EXPORT_COLUMNS.map((c) => ({ wch: c.key === "address" || c.key === "note" ? 28 : c.key === "customer" ? 22 : 13 }));
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transactions");

  if (summary && summary.length) {
    const sAoa = [["Group", "Count", "Money in", "Money out", "Net (cash)", "Credits applied"]];
    summary.forEach((g) => sAoa.push([g.label, g.count, g.moneyIn, g.moneyOut, g.net, g.credits]));
    const sws = XLSX.utils.aoa_to_sheet(sAoa);
    for (let i = 1; i < sAoa.length; i++) {
      [2, 3, 4, 5].forEach((c) => {
        const ref = XLSX.utils.encode_cell({ r: i, c });
        if (sws[ref] && typeof sws[ref].v === "number") sws[ref].z = '"$"#,##0.00';
      });
    }
    sws["!cols"] = [{ wch: 26 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, sws, "Summary");
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

/* =========================================================================
   REPORTS — named reports for ownership
   =========================================================================
   Each named report answers one question the same way every time. The query
   tool (TransactionReport) lives on the Ledger page instead. Every figure is
   computed in the database by an admin-only function, so the definitions sit
   in one place (see the comment on each function) and the browser never sees
   the underlying money tables in bulk. */

const NAMED_REPORTS = [
  { key: "scorecard", label: "Monthly scorecard", blurb: "Booked, collected, completed and gross profit, month by month." },
];

function ReportsView() {
  const [active, setActive] = useState(NAMED_REPORTS[0].key);
  const report = NAMED_REPORTS.find((r) => r.key === active) || NAMED_REPORTS[0];
  return (
    <div className="td-view">
      <div className="td-rpt-tabs" role="tablist">
        {NAMED_REPORTS.map((r) => (
          <button key={r.key} role="tab" aria-selected={r.key === active}
            className={cls("td-rpt-tab", r.key === active && "td-rpt-tab-on")} onClick={() => setActive(r.key)}>
            {r.label}
          </button>
        ))}
      </div>
      {report.key === "scorecard" && <ScorecardReport />}
    </div>
  );
}

const LEDGER_TABS = [
  { key: "balances", label: "Balances owed" },
  { key: "payments", label: "Payment reports" },
];

function LedgerView({ ctx }) {
  const [tab, setTab] = useState(LEDGER_TABS[0].key);
  return (
    <div className="td-view">
      <div className="td-rpt-tabs" role="tablist">
        {LEDGER_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tab}
            className={cls("td-rpt-tab", t.key === tab && "td-rpt-tab-on")} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "balances" && <BalancesOwedReport onOpenJob={ctx.setSelectedJobId} />}
      {tab === "payments" && <TransactionReport jobs={ctx.jobs} />}
    </div>
  );
}

const SC_PERIODS = [
  { key: "last12", label: "Last 12 months" },
  { key: "ytd", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom" },
];

const monthInput = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");

function scorecardRange(period, customFrom, customTo) {
  const now = new Date();
  const y = now.getFullYear();
  if (period === "ytd") return { from: y + "-01-01", to: isoDay(now) };
  if (period === "last_year") return { from: (y - 1) + "-01-01", to: (y - 1) + "-12-31" };
  if (period === "custom") {
    const [ty, tm] = (customTo || monthInput(now)).split("-").map(Number);
    const last = new Date(ty, tm, 0); // day 0 of next month = last day of this one
    return { from: (customFrom || monthInput(now)) + "-01", to: isoDay(last > now ? now : last) };
  }
  const start = new Date(y, now.getMonth() - 11, 1);
  return { from: isoDay(start), to: isoDay(now) };
}

const scMonthLabel = (m) => new Date(m + "T00:00:00").toLocaleString("en-US", { month: "short", year: "numeric" });

// One definition per column, shared by the table and both exports so the
// spreadsheet always says what the screen says.
const SC_COLUMNS = [
  { key: "booked", header: "Booked (signed)", money: true },
  { key: "booked_jobs", header: "Jobs signed" },
  { key: "collected", header: "Collected (cash)", money: true },
  { key: "completed", header: "Completed", money: true },
  { key: "completed_jobs", header: "Jobs completed" },
  { key: "finalized_revenue", header: "Finalized revenue", money: true },
  { key: "gp_finalized", header: "GP finalized", money: true },
  { key: "gp_provisional", header: "GP provisional", money: true },
  { key: "provisional_jobs", header: "Provisional jobs" },
  { key: "gp_total", header: "GP total", money: true },
];

function scTotals(months) {
  const t = {};
  SC_COLUMNS.forEach((c) => { t[c.key] = months.reduce((s, m) => s + Number(m[c.key] || 0), 0); });
  const rev = months.reduce((s, m) => s + Number(m.finalized_revenue || 0) + Number(m.provisional_revenue || 0), 0);
  t.gp_pct = rev > 0 ? t.gp_total / rev : null;
  // What the GP figure actually covers: only jobs with vendor costs entered.
  t.gp_revenue = rev;
  t.gp_jobs = months.reduce((s, m) => s + Number(m.provisional_jobs || 0) + Number(m.finalized_jobs || 0), 0);
  t.completed_jobs_n = months.reduce((s, m) => s + Number(m.completed_jobs || 0), 0);
  return t;
}

function scCoverageLines(c) {
  if (!c) return [];
  const since = c.stage_log_since ? fmtDate(c.stage_log_since) : "today (no stage moves logged yet)";
  return [
    ["Booked", c.jobs_with_signed_date + " of " + c.jobs_live + " live jobs have a contract signed date. Jobs without one are not in any month."],
    ["Completed", "Stage history started " + since + ". " + c.complete_with_completion_date + " of " + c.complete_stage_jobs +
      " completed/closed jobs have a completion date, from the Completion Log sheet or, failing that, the first move into a done stage. The rest are left out."],
    ["GP finalized", c.finalized_jobs + " job" + (c.finalized_jobs === 1 ? "" : "s") + " finalized. Each finalization counts in the month it was made, so past months do not move."],
    ["GP provisional", "Live margin on completed jobs not yet finalized: " + c.provisional_by_completion + " dated by completion, " +
      c.provisional_by_signed + " by signed date. " + c.provisional_undated + " more (" + money(c.provisional_undated_revenue) +
      " revenue) have no date and are not shown."],
    ["Left out of GP", c.complete_no_costs + " completed jobs (" + money(c.complete_no_costs_revenue) +
      " revenue) have no vendor costs recorded, so their margin would read as 100%."],
  ];
}

async function exportScorecard(data, kind) {
  const months = data.months || [];
  const t = scTotals(months);
  const header = ["Month", ...SC_COLUMNS.map((c) => c.header), "GP %"];
  const body = months.map((m) => [scMonthLabel(m.m), ...SC_COLUMNS.map((c) => Number(m[c.key] || 0)),
    m.gp_pct === null || m.gp_pct === undefined ? "" : Number(m.gp_pct)]);
  const total = ["TOTAL", ...SC_COLUMNS.map((c) => t[c.key]), t.gp_pct === null ? "" : t.gp_pct];
  const notes = scCoverageLines(data.coverage);
  const base = "scorecard_" + data.from + "_to_" + data.to;

  if (kind === "csv") {
    const cell = (v) => {
      let s = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [header, ...body, total, [], ["Coverage"], ...notes].map((r) => r.map(cell).join(","));
    downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }), base + ".csv");
    return;
  }

  const XLSX = await import("xlsx");
  const aoa = [header, ...body, total];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r < aoa.length; r++) {
    SC_COLUMNS.forEach((c, i) => {
      const ref = XLSX.utils.encode_cell({ r, c: i + 1 });
      if (c.money && ws[ref]) ws[ref].z = '"$"#,##0';
    });
    const pref = XLSX.utils.encode_cell({ r, c: SC_COLUMNS.length + 1 });
    if (ws[pref] && typeof ws[pref].v === "number") ws[pref].z = "0.0%";
  }
  ws["!cols"] = [{ wch: 11 }, ...SC_COLUMNS.map(() => ({ wch: 15 })), { wch: 8 }];
  ws["!freeze"] = { xSplit: 1, ySplit: 1 };
  const cws = XLSX.utils.aoa_to_sheet([["Line", "Coverage"], ...notes, [],
    ["Generated", new Date(data.generated_at).toLocaleString("en-US")], ["Period", data.from + " to " + data.to]]);
  cws["!cols"] = [{ wch: 16 }, { wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Scorecard");
  XLSX.utils.book_append_sheet(wb, cws, "Coverage");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), base + ".xlsx");
}

function ScorecardReport() {
  const [period, setPeriod] = useState("last12");
  const now = new Date();
  const [customFrom, setCustomFrom] = useState(monthInput(new Date(now.getFullYear(), now.getMonth() - 11, 1)));
  const [customTo, setCustomTo] = useState(monthInput(now));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const range = scorecardRange(period, customFrom, customTo);

  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    repo.reportMonthlyScorecard(range.from, range.to)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setData(null); setError(e.message || String(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.from, range.to]);

  const months = (data && data.months) || [];
  const t = scTotals(months);
  const doExport = async (kind) => {
    setBusy(kind);
    try { await exportScorecard(data, kind); } catch (e) { setError("Export failed: " + (e.message || e)); }
    finally { setBusy(""); }
  };

  return (
    <div className="td-sc">
      <div className="td-panel td-report">
        <div className="td-panel-head">
          <span><TrendingUp size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Monthly scorecard</span>
          <div className="td-report-actions">
            <button className="td-btn" disabled={!months.length || !!busy} onClick={() => doExport("csv")}>
              <Download size={13} /> {busy === "csv" ? "Exporting…" : "CSV"}
            </button>
            <button className="td-btn" disabled={!months.length || !!busy} onClick={() => doExport("xlsx")}>
              <FileSpreadsheet size={13} /> {busy === "xlsx" ? "Building…" : "Excel"}
            </button>
          </div>
        </div>
        <div className="td-report-controls">
          <label className="td-deal-field">
            <span className="td-field-label">Period</span>
            <select className="td-select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {SC_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          {period === "custom" && (
            <>
              <label className="td-deal-field">
                <span className="td-field-label">From month</span>
                <input className="td-input" type="month" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">To month</span>
                <input className="td-input" type="month" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </>
          )}
          <span className="td-report-range">{fmtDate(range.from + "T00:00:00")} – {fmtDate(range.to + "T00:00:00")}</span>
        </div>

        {error && <div className="td-sync-banner"><AlertTriangle size={15} /><span>{error}</span></div>}
        {loading && !data && <div className="td-sc-loading">Loading…</div>}

        {data && (
          <>
            <div className="td-stat-row">
              <TicketStat label="Booked (contracts signed)" value={money(t.booked)} icon={ClipboardList} accent="#B8860B"
                footnote={t.booked_jobs + " jobs" + (data.coverage ? " · only " + data.coverage.jobs_with_signed_date + " of " +
                  data.coverage.jobs_live + " live jobs have a signed date" : "")} />
              <TicketStat label="Collected (cash in)" value={money(t.collected)} icon={Wallet} accent="#3F8EA6" />
              <TicketStat label="Completed" value={money(t.completed)} icon={Check} accent="#6B5B95"
                footnote={t.completed_jobs + " jobs"} />
              <TicketStat label="Gross profit — costed jobs only" value={money(t.gp_total)} icon={Percent} accent="#3F7D58"
                footnote={(t.gp_pct === null ? "—" : pct(t.gp_pct)) + " on " + money(t.gp_revenue) + " revenue · " +
                  t.gp_jobs + " of " + t.completed_jobs_n + " completed jobs have vendor costs"} />
            </div>

            <div className="td-sc-chart">
              <TrendChart months={months} series={[
                { key: "booked", label: "Booked", color: "#B8860B" },
                { key: "collected", label: "Collected", color: "#3F8EA6" },
                { key: "gp_total", label: "Gross profit", color: "#3F7D58" },
              ]} />
            </div>

            <div className="td-table-wrap">
              <table className="td-table td-sc-table">
                <thead>
                  <tr>
                    <th>Month</th><th className="td-num">Booked</th><th className="td-num">Collected</th>
                    <th className="td-num">Completed</th><th className="td-num">GP finalized</th>
                    <th className="td-num">GP provisional</th><th className="td-num">GP total</th><th className="td-num">GP %</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.m}>
                      <td>{scMonthLabel(m.m)}</td>
                      <td className="td-num">{money(m.booked)}<span className="td-sc-sub">{m.booked_jobs || ""}</span></td>
                      <td className="td-num">{money(m.collected)}</td>
                      <td className="td-num">{money(m.completed)}<span className="td-sc-sub">{m.completed_jobs || ""}</span></td>
                      <td className="td-num">{money(m.gp_finalized)}</td>
                      <td className="td-num td-sc-prov" title={m.provisional_by_signed ? m.provisional_by_signed + " dated by signed date" : ""}>
                        {money(m.gp_provisional)}<span className="td-sc-sub">{m.provisional_jobs || ""}</span></td>
                      <td className="td-num"><strong>{money(m.gp_total)}</strong></td>
                      <td className="td-num">{m.gp_pct === null || m.gp_pct === undefined ? "—" : pct(m.gp_pct)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td className="td-num">{money(t.booked)}<span className="td-sc-sub" /></td><td className="td-num">{money(t.collected)}</td>
                    <td className="td-num">{money(t.completed)}<span className="td-sc-sub" /></td><td className="td-num">{money(t.gp_finalized)}</td>
                    <td className="td-num">{money(t.gp_provisional)}<span className="td-sc-sub" /></td><td className="td-num"><strong>{money(t.gp_total)}</strong></td>
                    <td className="td-num">{t.gp_pct === null ? "—" : pct(t.gp_pct)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="td-sc-key">Small numbers are job counts. Provisional GP is live margin on completed jobs not yet finalized and will move as vendor bills land.</p>
          </>
        )}
      </div>

      {data && data.coverage && (
        <div className="td-panel td-sc-coverage">
          <div className="td-panel-head"><span><AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />How complete these numbers are</span></div>
          <dl>
            {scCoverageLines(data.coverage).map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
          </dl>
        </div>
      )}
    </div>
  );
}

const shortMoney = (v) => {
  const a = Math.abs(v), s = v < 0 ? "-$" : "$";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return s + Math.round(a / 1e3) + "k";
  return s + Math.round(a);
};

function TrendChart({ months, series }) {
  if (!months.length) return null;
  const W = 760, H = 230, P = { l: 52, r: 14, t: 12, b: 26 };
  const vals = series.flatMap((s) => months.map((m) => Number(m[s.key]) || 0));
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const x = (i) => P.l + (months.length === 1 ? iw / 2 : (i * iw) / (months.length - 1));
  const y = (v) => P.t + ih * (1 - (v - min) / (max - min));
  const ticks = [0, 1, 2, 3, 4].map((i) => min + ((max - min) * i) / 4);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="td-sc-svg" role="img" aria-label="Monthly trend">
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#EBE6DC" />
            <text x={P.l - 6} y={y(v) + 4} textAnchor="end" className="td-sc-axis">{shortMoney(v)}</text>
          </g>
        ))}
        {months.map((m, i) => (
          <text key={m.m} x={x(i)} y={H - 6} textAnchor="middle" className="td-sc-axis">
            {new Date(m.m + "T00:00:00").toLocaleString("en-US", { month: "short" })}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round"
              points={months.map((m, i) => x(i) + "," + y(Number(m[s.key]) || 0)).join(" ")} />
            {months.map((m, i) => (
              <circle key={m.m} cx={x(i)} cy={y(Number(m[s.key]) || 0)} r="3.2" fill={s.color}>
                <title>{s.label} · {scMonthLabel(m.m)}: {money(m[s.key])}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="td-sc-legend">
        {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      </div>
    </div>
  );
}

/* =========================================================================
   BALANCES OWED — what is still owed on each job
   =========================================================================
   Computed in the database by report_balances_owed() (admin only). Per job:
     balance   = contract - collected - client_credited
     (contract stays the signed amount; client credits come from their own
     table and are never counted as collected)
     collected = the larger of the TradeDesk client payments and the amount the
                 Completion Log sheet says was collected. Older jobs often have
                 no payments entered in TradeDesk, and the sheet is the office's
                 record of them; `collected_source` says which figure won.
   Finished jobs (a complete stage) are true receivables. Open jobs are the
   contract still to be collected as the work proceeds — kept as a separate
   total so the two are never added together by accident. */

const BAL_SCOPES = [
  { key: "finished", label: "Finished jobs (receivables)" },
  { key: "open", label: "Open jobs (left to collect)" },
  { key: "all", label: "All jobs" },
];
const BAL_SHOW = [
  { key: "owing", label: "Still owing" },
  { key: "credit", label: "Overpaid (negative balance)" },
  { key: "all", label: "Everything" },
];
const BAL_GROUPS = [
  { key: "none", label: "No grouping" },
  { key: "age", label: "By age since completion" },
  { key: "stage", label: "By stage" },
  { key: "trade", label: "By trade" },
  { key: "source", label: "By where 'collected' came from" },
];
const BAL_AGE = [
  { key: "a0", label: "0–30 days", max: 30 },
  { key: "a1", label: "31–60 days", max: 60 },
  { key: "a2", label: "61–90 days", max: 90 },
  { key: "a3", label: "Over 90 days", max: Infinity },
];
const BAL_SOURCE_LABEL = {
  tradedesk: "TradeDesk payments",
  sheet: "Completion Log sheet",
  none: "Nothing collected",
};

const balAgeKey = (r) => {
  if (!r.finished) return "open";
  if (r.days_since_complete === null || r.days_since_complete === undefined) return "nodate";
  return (BAL_AGE.find((b) => r.days_since_complete <= b.max) || BAL_AGE[3]).key;
};
const balAgeLabel = (k) =>
  k === "open" ? "Not finished" : k === "nodate" ? "No completion date" : (BAL_AGE.find((b) => b.key === k) || {}).label || k;

/** The things worth a second look on one row, as short labels. */
function balFlags(r) {
  const f = [];
  if (r.collected_source === "sheet") f.push({ tone: "amber", text: "Sheet shows " + money(r.paid_sheet - r.paid_tradedesk) + " more collected than TradeDesk" });
  if (r.sheet_awaiting) f.push({ tone: "red", text: "Sheet: awaiting payment" });
  if (r.finished && !r.tradedesk_payments && r.collected_source !== "sheet") f.push({ tone: "red", text: "No payments in TradeDesk" + (r.in_sheet ? "" : " or the sheet") });
  if (!Number(r.contract)) f.push({ tone: "amber", text: "No contract amount" });
  if (r.contract_sheet !== null && r.contract_sheet !== undefined && Math.abs(Number(r.contract_sheet) - Number(r.contract)) >= 1)
    f.push({ tone: "grey", text: "Sheet contract " + money(r.contract_sheet) });
  return f;
}

const BAL_EXPORT = [
  { key: "job", header: "Job #", get: (r) => jobNo(r.number) },
  { key: "project", header: "GHL Project #", get: (r) => r.project_ref || "" },
  { key: "customer", header: "Customer", get: (r) => r.customer || "" },
  { key: "address", header: "Address", get: (r) => r.address || "" },
  { key: "trade", header: "Trade", get: (r) => (TRADES[r.trade] ? TRADES[r.trade].label : r.trade || "") },
  { key: "stage", header: "Stage", get: (r) => r.stage_label || r.stage || "" },
  { key: "kind", header: "Finished?", get: (r) => (r.finished ? "Finished" : "Open") },
  { key: "contract", header: "Contract", money: true, get: (r) => Number(r.contract || 0) },
  { key: "paid_td", header: "Paid (TradeDesk)", money: true, get: (r) => Number(r.paid_tradedesk || 0) },
  { key: "paid_sheet", header: "Collected (sheet)", money: true, get: (r) => (r.paid_sheet === null || r.paid_sheet === undefined ? "" : Number(r.paid_sheet)) },
  { key: "collected", header: "Collected (used)", money: true, get: (r) => Number(r.collected || 0) },
  { key: "credited", header: "Client credited", money: true, get: (r) => Number(r.client_credited || 0) },
  { key: "source", header: "Collected from", get: (r) => BAL_SOURCE_LABEL[r.collected_source] || r.collected_source },
  { key: "balance", header: "Balance owed", money: true, get: (r) => Number(r.balance || 0) },
  { key: "completed", header: "Completed", get: (r) => (r.completed_at ? isoDay(r.completed_at) : "") },
  { key: "days", header: "Days since completed", get: (r) => (r.days_since_complete === null || r.days_since_complete === undefined ? "" : r.days_since_complete) },
  { key: "last_td", header: "Last TradeDesk payment", get: (r) => (r.last_paid_tradedesk ? isoDay(r.last_paid_tradedesk) : "") },
  { key: "last_sheet", header: "Sheet collected date", get: (r) => r.last_paid_sheet || "" },
  { key: "flags", header: "Check", get: (r) => balFlags(r).map((f) => f.text).join("; ") },
];

function exportBalancesCsv(rows, filename) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [BAL_EXPORT.map((c) => cell(c.header)).join(",")];
  rows.forEach((r) => lines.push(BAL_EXPORT.map((c) => cell(c.get(r))).join(",")));
  downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }), filename);
}

async function exportBalancesXlsx(rows, groups, filename) {
  const XLSX = await import("xlsx");
  const fmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
  const aoa = [BAL_EXPORT.map((c) => c.header)];
  rows.forEach((r) => aoa.push(BAL_EXPORT.map((c) => c.get(r))));
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  aoa.push([]);
  const tot = BAL_EXPORT.map(() => "");
  tot[0] = "TOTAL";
  tot[BAL_EXPORT.findIndex((c) => c.key === "contract")] = sum("contract");
  tot[BAL_EXPORT.findIndex((c) => c.key === "collected")] = sum("collected");
  tot[BAL_EXPORT.findIndex((c) => c.key === "credited")] = sum("client_credited");
  tot[BAL_EXPORT.findIndex((c) => c.key === "balance")] = sum("balance");
  aoa.push(tot);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  BAL_EXPORT.forEach((c, ci) => {
    if (!c.money) return;
    for (let i = 1; i < aoa.length; i++) {
      const ref = XLSX.utils.encode_cell({ r: i, c: ci });
      if (ws[ref] && typeof ws[ref].v === "number") ws[ref].z = fmt;
    }
  });
  ws["!cols"] = BAL_EXPORT.map((c) => ({ wch: c.key === "address" || c.key === "flags" ? 32 : c.key === "customer" ? 22 : 14 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Balances");

  const sAoa = [["Group", "Jobs", "Contract", "Collected", "Balance owed"]];
  groups.forEach((g) => sAoa.push([g.label, g.count, g.contract, g.collected, g.balance]));
  const sws = XLSX.utils.aoa_to_sheet(sAoa);
  for (let i = 1; i < sAoa.length; i++) [2, 3, 4].forEach((c) => {
    const ref = XLSX.utils.encode_cell({ r: i, c });
    if (sws[ref] && typeof sws[ref].v === "number") sws[ref].z = fmt;
  });
  sws["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, sws, "Summary");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

function BalancesOwedReport({ onOpenJob }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [scope, setScope] = useState("finished");
  const [show, setShow] = useState("owing");
  const [groupBy, setGroupBy] = useState("age");
  const [fTrade, setFTrade] = useState("");
  const [fStage, setFStage] = useState("");
  const [fSource, setFSource] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    repo.reportBalancesOwed()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setData(null); setError(e.message || String(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reloadKey]);

  const all = useMemo(() => ((data && data.rows) || []).map((r) => ({
    ...r,
    contract: Number(r.contract || 0), collected: Number(r.collected || 0), balance: Number(r.balance || 0),
    client_credited: Number(r.client_credited || 0), client_credits_count: Number(r.client_credits_count || 0),
    paid_tradedesk: Number(r.paid_tradedesk || 0),
    paid_sheet: r.paid_sheet === null || r.paid_sheet === undefined ? null : Number(r.paid_sheet),
  })), [data]);

  // Headline figures ignore the filters on purpose: they are the answer to
  // "how much is owed", and should read the same however the table is cut.
  const head = useMemo(() => {
    const owing = (r) => r.balance >= 1;
    const fin = all.filter((r) => r.finished && owing(r));
    const open = all.filter((r) => !r.finished && owing(r));
    const sheetOnly = all.filter((r) => r.finished && r.collected_source === "sheet");
    const credits = all.filter((r) => r.balance <= -1);
    const s = (xs, k = "balance") => xs.reduce((t, r) => t + r[k], 0);
    return {
      finished: s(fin), finishedJobs: fin.length,
      over90: s(fin.filter((r) => r.days_since_complete > 90)),
      open: s(open), openJobs: open.length,
      sheetOnlyJobs: sheetOnly.length, sheetOnlyGap: sheetOnly.reduce((t, r) => t + (r.paid_sheet - r.paid_tradedesk), 0),
      credits: -s(credits), creditJobs: credits.length,
      // Straight from the server, across every job, like the other headlines.
      clientCredited: Number((data && data.client_credited_total) || 0),
      clientCreditedJobs: all.filter((r) => r.client_credited > 0).length,
    };
  }, [all, data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (scope === "finished" && !r.finished) return false;
      if (scope === "open" && r.finished) return false;
      if (show === "owing" && !(r.balance >= 1)) return false;
      if (show === "credit" && !(r.balance <= -1)) return false;
      if (fTrade && r.trade !== fTrade) return false;
      if (fStage && r.stage !== fStage) return false;
      if (fSource && r.collected_source !== fSource) return false;
      if (q && ![r.customer, r.address, r.project_ref, jobNo(r.number)].some((v) => String(v || "").toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => (show === "credit" ? a.balance - b.balance : b.balance - a.balance));
  }, [all, scope, show, fTrade, fStage, fSource, search]);

  const groups = useMemo(() => {
    const keyOf = {
      none: () => "all",
      age: balAgeKey,
      stage: (r) => r.stage,
      trade: (r) => r.trade || "",
      source: (r) => r.collected_source,
    }[groupBy];
    const labelOf = {
      none: () => "All jobs shown",
      age: balAgeLabel,
      stage: (k, r) => r.stage_label || k,
      trade: (k) => (TRADES[k] ? TRADES[k].label : k || "—"),
      source: (k) => BAL_SOURCE_LABEL[k] || k,
    }[groupBy];
    const order = { a0: 0, a1: 1, a2: 2, a3: 3, nodate: 4, open: 5 };
    const map = new Map();
    rows.forEach((r) => {
      const k = keyOf(r);
      const e = map.get(k) || { key: k, label: labelOf(k, r), count: 0, contract: 0, collected: 0, balance: 0 };
      e.count += 1; e.contract += r.contract; e.collected += r.collected; e.balance += r.balance;
      map.set(k, e);
    });
    return [...map.values()].sort((a, b) =>
      groupBy === "age" ? (order[a.key] ?? 9) - (order[b.key] ?? 9) : Math.abs(b.balance) - Math.abs(a.balance));
  }, [rows, groupBy]);

  const tot = rows.reduce((t, r) => ({ contract: t.contract + r.contract, collected: t.collected + r.collected, balance: t.balance + r.balance }),
    { contract: 0, collected: 0, balance: 0 });

  const tradeKeys = useMemo(() => [...new Set(all.map((r) => r.trade).filter(Boolean))].sort(), [all]);
  const stageOpts = useMemo(() => {
    const m = new Map();
    all.forEach((r) => { if (!m.has(r.stage)) m.set(r.stage, r.stage_label || r.stage); });
    return [...m.entries()];
  }, [all]);

  const activeFilters = [fTrade, fStage, fSource, search].filter(Boolean).length;
  const reset = () => { setFTrade(""); setFStage(""); setFSource(""); setSearch(""); };
  const filenameBase = "tradedesk_balances-owed_" + scope + "_" + isoDay(new Date());
  const doExport = async (kind) => {
    if (!rows.length) return;
    setBusy(kind);
    try {
      if (kind === "csv") exportBalancesCsv(rows, filenameBase + ".csv");
      else await exportBalancesXlsx(rows, groups, filenameBase + ".xlsx");
    } catch (e) { setError("Export failed: " + (e.message || e)); }
    finally { setBusy(""); }
  };

  return (
    <div className="td-sc td-bal">
      <div className="td-panel td-report">
        <div className="td-panel-head">
          <span><Wallet size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Balances owed</span>
          <div className="td-report-actions">
            <button className="td-btn" disabled={loading} onClick={() => setReloadKey((k) => k + 1)} title="Reload from the database">
              <RefreshCw size={13} /> Refresh
            </button>
            <button className="td-btn" disabled={!rows.length || !!busy} onClick={() => doExport("csv")}>
              <Download size={13} /> {busy === "csv" ? "Exporting…" : "CSV"}
            </button>
            <button className="td-btn" disabled={!rows.length || !!busy} onClick={() => doExport("xlsx")}>
              <FileSpreadsheet size={13} /> {busy === "xlsx" ? "Building…" : "Excel"}
            </button>
          </div>
        </div>

        {error && <div className="td-sync-banner"><AlertTriangle size={15} /><span>{error}</span></div>}
        {loading && !data && <div className="td-sc-loading">Loading…</div>}

        {data && (
          <>
            <div className="td-stat-row">
              <TicketStat label="Owed on finished jobs" value={money(head.finished)} icon={Wallet} accent="#C1440E"
                footnote={head.finishedJobs + " jobs · " + money(head.over90) + " over 90 days"} />
              <TicketStat label="Left to collect on open jobs" value={money(head.open)} icon={ClipboardList} accent="#B8860B"
                footnote={head.openJobs + " jobs not finished yet"} />
              <TicketStat label="Paid per sheet, not in TradeDesk" value={String(head.sheetOnlyJobs)} icon={AlertTriangle} accent="#8A5A12"
                footnote={money(head.sheetOnlyGap) + " of payments to enter"} />
              <TicketStat label="Overpaid" value={money(head.credits)} icon={HandCoins} accent="#3F7D58"
                footnote={head.creditJobs + " jobs with a negative balance"} />
              <TicketStat label="Client Credited Total" value={money(head.clientCredited)} icon={Minus} accent="#6A4C93"
                footnote={head.clientCreditedJobs + " job" + (head.clientCreditedJobs === 1 ? "" : "s") + " · taken off balances, not refunds"} />
            </div>

            <div className="td-report-controls">
              <label className="td-deal-field">
                <span className="td-field-label">Jobs</span>
                <select className="td-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                  {BAL_SCOPES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">Show</span>
                <select className="td-select" value={show} onChange={(e) => setShow(e.target.value)}>
                  {BAL_SHOW.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">Group</span>
                <select className="td-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  {BAL_GROUPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">Trade</span>
                <select className="td-select" value={fTrade} onChange={(e) => setFTrade(e.target.value)}>
                  <option value="">All trades</option>
                  {tradeKeys.map((k) => <option key={k} value={k}>{TRADES[k] ? TRADES[k].label : k}</option>)}
                </select>
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">Stage</span>
                <select className="td-select" value={fStage} onChange={(e) => setFStage(e.target.value)}>
                  <option value="">All stages</option>
                  {stageOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label className="td-deal-field">
                <span className="td-field-label">Collected from</span>
                <select className="td-select" value={fSource} onChange={(e) => setFSource(e.target.value)}>
                  <option value="">Any source</option>
                  {Object.entries(BAL_SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label className="td-deal-field td-report-search">
                <span className="td-field-label">Search</span>
                <input className="td-input" placeholder="Customer, address, job #, project #" value={search}
                  onChange={(e) => setSearch(e.target.value)} />
              </label>
              {activeFilters > 0 && (
                <button className="td-btn td-report-reset" onClick={reset}>
                  <X size={13} /> Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
                </button>
              )}
            </div>

            {rows.length === 0 ? (
              <EmptyState icon={Wallet} title="Nothing matches" sub="Change the job scope or clear a filter." />
            ) : (
              <>
                <div className="td-table-wrap">
                  <table className="td-table td-sc-table">
                    <thead>
                      <tr>
                        <th>{(BAL_GROUPS.find((g) => g.key === groupBy) || {}).label.replace(/^By /, "").replace(/^No grouping$/, "Total")}</th>
                        <th className="td-num">Jobs</th><th className="td-num">Contract</th>
                        <th className="td-num">Collected</th><th className="td-num">Balance owed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.key}>
                          <td>{g.label}</td>
                          <td className="td-num">{g.count}</td>
                          <td className="td-num">{money(g.contract)}</td>
                          <td className="td-num">{money(g.collected)}</td>
                          <td className={"td-num " + (g.balance < 0 ? "td-text-green" : "td-text-red")}><strong>{money(g.balance)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="td-num"><strong>{rows.length}</strong></td>
                        <td className="td-num"><strong>{money(tot.contract)}</strong></td>
                        <td className="td-num"><strong>{money(tot.collected)}</strong></td>
                        <td className="td-num"><strong>{money(tot.balance)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="td-table-wrap td-bal-jobs">
                  <table className="td-table">
                    <thead>
                      <tr>
                        <th>Job</th><th>Customer</th><th>Stage</th>
                        <th className="td-num">Contract</th><th className="td-num">Collected</th>
                        <th className="td-num">Credited</th><th className="td-num">Balance</th>
                        <th>Completed</th><th>Last payment</th><th>Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const flags = balFlags(r);
                        return (
                          <tr key={r.job_id} className="td-bal-row" onClick={() => onOpenJob && onOpenJob(r.job_id)} title="Open this job">
                            <td>
                              <div className="td-bal-job">{jobNo(r.number)}</div>
                              {r.project_ref && <div className="td-bal-sub">GHL #{r.project_ref}</div>}
                            </td>
                            <td>
                              <div>{r.customer}</div>
                              <div className="td-bal-sub">{String(r.address || "").split(",")[0]}</div>
                            </td>
                            <td>{r.stage_label}</td>
                            <td className="td-num">{money(r.contract)}</td>
                            <td className="td-num">
                              {money(r.collected)}
                              {r.collected_source === "sheet" && <span className="td-bal-src" title={"TradeDesk has " + money(r.paid_tradedesk) + "; the Completion Log says " + money(r.paid_sheet)}>sheet</span>}
                            </td>
                            <td className="td-num">
                              {r.client_credited > 0
                                ? <span className="td-credit-text" title={r.client_credits_count + " client credit" + (r.client_credits_count === 1 ? "" : "s")}>{"\u2212" + money(r.client_credited)}</span>
                                : <span className="td-bal-sub">—</span>}
                            </td>
                            <td className={"td-num " + (r.balance < 0 ? "td-text-green" : r.balance >= 1 ? "td-text-red" : "")}><strong>{money(r.balance)}</strong></td>
                            <td>
                              {r.completed_at ? fmtDate(r.completed_at) : <span className="td-bal-sub">—</span>}
                              {r.days_since_complete !== null && r.days_since_complete !== undefined &&
                                <div className={cls("td-bal-sub", r.days_since_complete > 90 && r.balance >= 1 && "td-text-red")}>{r.days_since_complete} days</div>}
                            </td>
                            <td>
                              {r.last_paid_tradedesk ? fmtDate(r.last_paid_tradedesk)
                                : r.last_paid_sheet ? <span>{fmtDate(r.last_paid_sheet + "T00:00:00")} <span className="td-bal-sub">(sheet)</span></span>
                                : <span className="td-bal-sub">none</span>}
                            </td>
                            <td>
                              <div className="td-bal-flags">
                                {flags.map((f, i) => <span key={i} className={"td-bal-flag td-bal-flag-" + f.tone}>{f.text}</span>)}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="td-sc-key">
              Balance = contract − collected. Collected is the larger of the payments entered in TradeDesk and the
              Completion Log's AMOUNT COLLECTED; rows marked <em>sheet</em> took the sheet's figure, so those payments
              still need entering in TradeDesk. Change orders not yet added to a job's contract show up as credits.
              Lost and abandoned jobs are left out. Click a row to open the job.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The report builder. Filters narrow the row set, the grouping decides how the
 * summary is cut, and both exports take exactly what is on screen — so a figure
 * in a spreadsheet can always be traced back to the filters that produced it.
 */
function TransactionReport({ jobs }) {
  const [preset, setPreset] = useState("this_month");
  const [customFrom, setCustomFrom] = useState(isoDay(startOfMonth(new Date())));
  const [customTo, setCustomTo] = useState(isoDay(new Date()));
  const [groupBy, setGroupBy] = useState("week");
  const [direction, setDirection] = useState("in");
  const [fType, setFType] = useState("");
  const [fMethod, setFMethod] = useState("");
  const [fTrade, setFTrade] = useState("");
  const [fStage, setFStage] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [search, setSearch] = useState("");
  const [showRows, setShowRows] = useState(false);
  const [busy, setBusy] = useState("");

  const [from, to] = useMemo(() => {
    if (preset === "custom") return [dayStart(customFrom), dayEnd(customTo)];
    const [a, b] = DATE_PRESETS[preset].range();
    return [dayStart(a), dayEnd(b)];
  }, [preset, customFrom, customTo]);

  const { rows: allRows, undated } = useMemo(() => buildLedgerRows(jobs), [jobs]);

  // Which ledgers the "Show" choice includes. "both" stays payments + costs
  // (cash only); "all" adds client credits on top.
  const showIn = ["in", "both", "all"].includes(direction);
  const showOut = ["out", "both", "all"].includes(direction);
  const showCredit = ["credit", "all"].includes(direction);
  const showNet = showIn && showOut;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!from || !to) return [];
    return allRows.filter((r) => {
      if (!(r.when >= from && r.when <= to)) return false;
      if (r.direction === "in" && !showIn) return false;
      if (r.direction === "out" && !showOut) return false;
      if (r.direction === "credit" && !showCredit) return false;
      if (fType && r.typeKey !== fType) return false;
      if (fMethod && r.method !== fMethod) return false;
      if (fTrade && r.tradeKey !== fTrade) return false;
      if (fStage && r.stageKey !== fStage) return false;
      if (fVendor && r.vendor !== fVendor) return false;
      if (fCategory && r.category !== fCategory) return false;
      if (fStatus && r.status !== fStatus) return false;
      if (q && !(String(r.customer).toLowerCase().includes(q) ||
                 String(r.vendor).toLowerCase().includes(q) ||
                 String(r.address).toLowerCase().includes(q) ||
                 String(r.note).toLowerCase().includes(q) ||
                 jobNo(r.jobNumber).toLowerCase().includes(q) ||
                 String(r.projectRef).toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => b.when - a.when);
  }, [allRows, from, to, showIn, showOut, showCredit, fType, fMethod, fTrade, fStage, fVendor, fCategory, fStatus, search]);

  const groups = useMemo(() => {
    const g = GROUPINGS[groupBy] || GROUPINGS.none;
    const map = new Map();
    rows.forEach((r) => {
      const key = g.key(r.when, r);
      const e = map.get(key) || { key, count: 0, moneyIn: 0, moneyOut: 0, credits: 0 };
      e.count += 1;
      if (r.direction === "in") e.moneyIn += r.amount;
      else if (r.direction === "out") e.moneyOut += r.amount;
      else if (r.direction === "credit") e.credits += r.amount;
      map.set(key, e);
    });
    const dateGrouped = ["day", "week", "month", "quarter", "year"].includes(groupBy);
    return [...map.values()]
      .map((e) => ({ ...e, net: e.moneyIn - e.moneyOut, label: groupLabel(groupBy, e.key) }))
      .sort((a, b) => dateGrouped ? (a.key < b.key ? 1 : -1) : (b.moneyIn + b.moneyOut + b.credits) - (a.moneyIn + a.moneyOut + a.credits));
  }, [rows, groupBy]);

  const totalIn = rows.filter((r) => r.direction === "in").reduce((s, r) => s + r.amount, 0);
  const totalOut = rows.filter((r) => r.direction === "out").reduce((s, r) => s + r.amount, 0);
  const totalCredit = rows.filter((r) => r.direction === "credit").reduce((s, r) => s + r.amount, 0);
  const creditJobs = new Set(rows.filter((r) => r.direction === "credit").map((r) => r.jobNumber)).size;

  const vendorNames = useMemo(
    () => [...new Set(allRows.filter((r) => r.vendor).map((r) => r.vendor))].sort(), [allRows]);

  const rangeLabel = isoDay(from) + "_to_" + isoDay(to);
  const filenameBase = "tradedesk_" +
    ({ in: "client-payments", out: "vendor-costs", credit: "client-credits", both: "payments-and-costs", all: "all-transactions" }[direction] || "transactions") +
    "_" + rangeLabel;

  const doExport = async (kind) => {
    if (!rows.length) return;
    setBusy(kind);
    try {
      if (kind === "csv") exportCsv(rows, filenameBase + ".csv");
      else await exportXlsx(rows, filenameBase + ".xlsx", groups);
    } catch (err) {
      alert("Export failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      setBusy("");
    }
  };

  const reset = () => {
    setFType(""); setFMethod(""); setFTrade(""); setFStage("");
    setFVendor(""); setFCategory(""); setFStatus(""); setSearch("");
  };
  const activeFilters = [fType, fMethod, fTrade, fStage, fVendor, fCategory, fStatus, search].filter(Boolean).length;

  return (
    <div className="td-panel td-report">
      <div className="td-panel-head">
        <span><SlidersHorizontal size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Payment reports</span>
        <div className="td-report-actions">
          <button className="td-btn" disabled={!rows.length || busy} onClick={() => doExport("csv")}>
            <Download size={13} /> {busy === "csv" ? "Exporting…" : "CSV"}
          </button>
          <button className="td-btn" disabled={!rows.length || busy} onClick={() => doExport("xlsx")}>
            <FileSpreadsheet size={13} /> {busy === "xlsx" ? "Building…" : "Excel"}
          </button>
        </div>
      </div>

      <div className="td-report-controls">
        <label className="td-deal-field">
          <span className="td-field-label">Period</span>
          <select className="td-select" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(DATE_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className="td-deal-field">
              <span className="td-field-label">From</span>
              <input className="td-input" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">To</span>
              <input className="td-input" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </>
        )}
        <label className="td-deal-field">
          <span className="td-field-label">Show</span>
          <select className="td-select" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="in">Client payments (money in)</option>
            <option value="out">Vendor costs (money out)</option>
            <option value="credit">Client credits</option>
            <option value="both">Payments + costs</option>
            <option value="all">Everything (incl. credits)</option>
          </select>
        </label>
        <label className="td-deal-field">
          <span className="td-field-label">Group</span>
          <select className="td-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {Object.entries(GROUPINGS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>

        {showIn && (
          <>
            <label className="td-deal-field">
              <span className="td-field-label">Payment type</span>
              <select className="td-select" value={fType} onChange={(e) => setFType(e.target.value)}>
                <option value="">All types</option>
                {paymentTypeKeys().map((k) => <option key={k} value={k}>{PAYMENT_TYPES[k].label}</option>)}
              </select>
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Method</span>
              <select className="td-select" value={fMethod} onChange={(e) => setFMethod(e.target.value)}>
                <option value="">All methods</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </>
        )}

        {showOut && (
          <>
            <label className="td-deal-field">
              <span className="td-field-label">Cost category</span>
              <select className="td-select" value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
                <option value="">All categories</option>
                {VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Vendor</span>
              <select className="td-select" value={fVendor} onChange={(e) => setFVendor(e.target.value)}>
                <option value="">All vendors</option>
                {vendorNames.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="td-deal-field">
              <span className="td-field-label">Status</span>
              <select className="td-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">Paid and pending</option>
                <option value="paid">Paid only</option>
                <option value="pending">Pending only</option>
              </select>
            </label>
          </>
        )}

        <label className="td-deal-field">
          <span className="td-field-label">Trade</span>
          <select className="td-select" value={fTrade} onChange={(e) => setFTrade(e.target.value)}>
            <option value="">All trades</option>
            {tradeKeysFor(jobs).map((k) => <option key={k} value={k}>{TRADES[k] ? TRADES[k].label : k}</option>)}
          </select>
        </label>
        <label className="td-deal-field">
          <span className="td-field-label">Stage</span>
          <select className="td-select" value={fStage} onChange={(e) => setFStage(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="td-deal-field td-report-search">
          <span className="td-field-label">Search</span>
          <input className="td-input" placeholder={showCredit ? "Customer, vendor, address, job #, credit reason" : "Customer, vendor, address, job #"} value={search}
            onChange={(e) => setSearch(e.target.value)} />
        </label>
        {activeFilters > 0 && (
          <button className="td-btn td-report-reset" onClick={reset}>
            <X size={13} /> Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div className="td-report-totals">
        <div><span className="td-field-label">Transactions</span><strong>{rows.length}</strong></div>
        {showIn && <div><span className="td-field-label">Money in</span><strong className="td-text-green">{money(totalIn)}</strong></div>}
        {showOut && <div><span className="td-field-label">Money out</span><strong className="td-text-red">{money(totalOut)}</strong></div>}
        {showNet && <div title="Cash only — client credits are not money in or out"><span className="td-field-label">Net</span><strong className={totalIn - totalOut < 0 ? "td-text-red" : "td-text-green"}>{money(totalIn - totalOut)}</strong></div>}
        {showCredit && <div title="Taken off what clients owe. Not cash, not refunds."><span className="td-field-label">Credits applied</span><strong className="td-credit-text">{totalCredit ? "\u2212" + money(totalCredit) : money(0)}</strong></div>}
        {showCredit && <div><span className="td-field-label">Jobs credited</span><strong>{creditJobs}</strong></div>}
        {undated > 0 && (
          <div title="These have no usable payment date, so they cannot belong to any period.">
            <span className="td-field-label">Undated</span>
            <strong className="td-text-red">{undated}</strong>
          </div>
        )}
        <div className="td-report-range">
          {from && to ? isoDay(from) + " → " + isoDay(to) : "Pick a valid date range"}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={CalendarIcon} title="Nothing in this period"
          sub="Widen the date range or clear a filter." />
      ) : (
        <>
          <div className="td-table-wrap">
            <table className="td-table">
              <thead>
                <tr>
                  <th>{GROUPINGS[groupBy].label.replace(/^By /, "").replace(/^No grouping$/, "Total")}</th>
                  <th className="td-num">Count</th>
                  {showIn && <th className="td-num">Money in</th>}
                  {showOut && <th className="td-num">Money out</th>}
                  {showNet && <th className="td-num">Net</th>}
                  {showCredit && <th className="td-num">Credits applied</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td>{g.label}</td>
                    <td className="td-num">{g.count}</td>
                    {showIn && <td className="td-num td-text-green">{money(g.moneyIn)}</td>}
                    {showOut && <td className="td-num td-text-red">{money(g.moneyOut)}</td>}
                    {showNet && <td className={"td-num " + (g.net < 0 ? "td-text-red" : "td-text-green")}>{money(g.net)}</td>}
                    {showCredit && <td className="td-num td-credit-text">{g.credits ? "\u2212" + money(g.credits) : money(0)}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="td-num"><strong>{rows.length}</strong></td>
                  {showIn && <td className="td-num"><strong>{money(totalIn)}</strong></td>}
                  {showOut && <td className="td-num"><strong>{money(totalOut)}</strong></td>}
                  {showNet && <td className="td-num"><strong>{money(totalIn - totalOut)}</strong></td>}
                  {showCredit && <td className="td-num"><strong>{totalCredit ? "\u2212" + money(totalCredit) : money(0)}</strong></td>}
                </tr>
              </tfoot>
            </table>
          </div>

          <button className="td-btn td-report-toggle" onClick={() => setShowRows((s) => !s)}>
            <ArrowDownUp size={13} /> {showRows ? "Hide" : "Show"} the {rows.length} individual transaction{rows.length === 1 ? "" : "s"}
          </button>

          {showRows && (
            <div className="td-table-wrap">
              <table className="td-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Type</th><th className="td-num">Amount</th>
                    <th>Customer</th><th>Job</th><th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 500).map((r) => (
                    <tr key={r.direction + r.id}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.typeLabel}{r.fromCrm && <span className="td-ghl-badge" style={{ marginLeft: 6 }}>GHL</span>}</td>
                      <td className={"td-num " + (r.direction === "in" ? "td-text-green" : r.direction === "credit" ? "td-credit-text" : "td-text-red")}>
                        {r.direction === "in" ? "" : "\u2212"}{moneyDec(r.amount)}
                      </td>
                      <td>{r.customer}</td>
                      <td>{jobNo(r.jobNumber)}</td>
                      <td className="td-cell-sub">
                        {[r.method, r.vendor, r.direction === "out" ? r.status : null, r.direction === "credit" && r.note ? "\u201c" + r.note + "\u201d" : r.note]
                          .filter(Boolean).join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 500 && (
                <div className="td-report-trunc">
                  Showing the first 500 of {rows.length}. The export includes all of them.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* =========================================================================
   GLOBAL STYLE
   ========================================================================= */

/* =========================================================================
   CALENDAR — who is where, and when
   -------------------------------------------------------------------------
   The board answers "what stage is this job at". This answers "who is working
   on Thursday", which the board cannot, because a column has no dates in it.

   Two views over the same events. The month grid is for "what is happening in
   November"; the per-person timeline is for "is Mike free that week", and the
   second question is the one that actually gets asked when someone rings up
   wanting a date.

   A person's colour comes from their assignee row and never changes, so the
   same green means the same crew in every month you page through.
   ========================================================================= */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The street line, which is what identifies a job at a glance on a small block. */
const shortAddress = (job) =>
  String((job && job.customerAddress) || "").split(",")[0].trim() || (job && job.customerName) || "";

const sameDay = (a, b) =>
  a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Stack overlapping bars so none hides another. Each lane records the first
 * column it is free from; a segment drops into the first lane whose free point
 * has been passed. Longest-first within a start column, so the long run of work
 * sits above the one-day visit rather than under it.
 */
function packLanes(segments) {
  const freeFrom = [];
  segments.forEach((s) => {
    let lane = 0;
    while (freeFrom[lane] !== undefined && freeFrom[lane] > s.colStart) lane++;
    s.lane = lane;
    freeFrom[lane] = s.colEnd + 1;
  });
  return segments.reduce((m, s) => Math.max(m, s.lane + 1), 0);
}

function CalendarView({ ctx }) {
  const { jobs, assigneeById, setSelectedJobId, search } = ctx;
  const [mode, setMode] = useState("month");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [roleFilter, setRoleFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState("all");
  const [popover, setPopover] = useState(null);

  const today = dayStart(new Date());
  const monthStart = cursor;
  const monthEnd = useMemo(
    () => dayStart(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)), [cursor]);
  const daysInMonth = monthEnd.getDate();

  /**
   * Every booking that can be drawn. An assignment with no start date is a
   * decision about who, not about when — it belongs on the card, and putting
   * it somewhere arbitrary on the calendar would be a lie. No end date reads
   * as a single day.
   */
  const events = useMemo(() => {
    const out = [];
    jobs.forEach((j) => {
      (j.assignments || []).forEach((a) => {
        if (!assigneeRole(a.role).scheduled) return;
        const start = dayStart(a.startDate);
        if (!start) return;
        const end = dayStart(a.endDate) || start;
        if (end < start) return;
        out.push({ id: a.id, job: j, assignment: a, person: assigneeById.get(a.assigneeId), start, end });
      });
    });
    return out;
  }, [jobs, assigneeById]);

  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() => events.filter((ev) => {
    if (roleFilter !== "all" && ev.assignment.role !== roleFilter) return false;
    if (personFilter !== "all" && ev.assignment.assigneeId !== personFilter) return false;
    if (!needle) return true;
    const hay = [ev.job.customerName, ev.job.customerAddress, jobRef(ev.job),
                 ev.person && ev.person.name].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  }), [events, roleFilter, personFilter, needle]);

  const inMonth = useMemo(
    () => filtered.filter((ev) => ev.end >= monthStart && ev.start <= monthEnd),
    [filtered, monthStart, monthEnd]);

  // Only people who actually appear this month, so the timeline is not mostly
  // empty rows for crews working elsewhere.
  const peopleThisMonth = useMemo(() => {
    const seen = new Map();
    inMonth.forEach((ev) => { if (ev.person && !seen.has(ev.person.id)) seen.set(ev.person.id, ev.person); });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [inMonth]);

  const everyone = useMemo(() => {
    const seen = new Map();
    events.forEach((ev) => { if (ev.person && !seen.has(ev.person.id)) seen.set(ev.person.id, ev.person); });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);

  const weeks = useMemo(() => {
    const out = [];
    let cur = startOfWeek(monthStart);
    const last = startOfWeek(monthEnd);
    while (cur <= last) { out.push(cur); cur = addDaysTo(cur, 7); }
    return out;
  }, [monthStart, monthEnd]);

  /** Clip events to a window and turn them into grid-placed segments. */
  const segmentsFor = (list, winStart, winEnd) => {
    const segs = list
      .filter((ev) => ev.end >= winStart && ev.start <= winEnd)
      .map((ev) => {
        const s = ev.start < winStart ? winStart : ev.start;
        const e = ev.end > winEnd ? winEnd : ev.end;
        return {
          ev,
          // Rounded, not floored: a window that spans a daylight-saving change
          // is 6.96 or 7.04 days long, and flooring would shunt every bar after
          // the change back a column.
          colStart: Math.round((s - winStart) / 86400000),
          colEnd: Math.round((e - winStart) / 86400000),
          openLeft: ev.start < winStart,
          openRight: ev.end > winEnd,
        };
      })
      .sort((a, b) => a.colStart - b.colStart || (b.colEnd - b.colStart) - (a.colEnd - a.colStart));
    const lanes = packLanes(segs);
    return { segs, lanes };
  };

  const openPopover = (e, ev) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPopover({ ev, x: r.left, y: r.bottom + 6 });
  };

  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const Bar = ({ s }) => {
    const color = (s.ev.person && s.ev.person.color) || "#4A6070";
    return (
      <button type="button"
        className={cls("td-cal-bar", s.openLeft && "td-cal-bar-l", s.openRight && "td-cal-bar-r")}
        style={{
          gridColumn: (s.colStart + 1) + " / span " + (s.colEnd - s.colStart + 1),
          gridRow: s.lane + 1,
          background: color,
          color: textOn(color),
        }}
        onClick={(e) => openPopover(e, s.ev)}
        title={(s.ev.person ? s.ev.person.name : "Unknown") + " · " + shortAddress(s.ev.job) + " · " +
               fmtDateRange(s.ev.assignment.startDate, s.ev.assignment.endDate)}>
        <span className="td-cal-bar-text">
          <strong>{s.ev.person ? s.ev.person.name : "Unknown"}</strong>
          <span>{shortAddress(s.ev.job)}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="td-cal">
      <div className="td-panel">
        <div className="td-panel-head td-cal-head">
          <div className="td-cal-nav">
            <button className="td-btn td-btn-sm" onClick={() => setCursor(startOfMonth(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)))} aria-label="Previous month"><ChevronLeft size={14} /></button>
            <button className="td-btn td-btn-sm" onClick={() => setCursor(startOfMonth(new Date()))}>Today</button>
            <button className="td-btn td-btn-sm" onClick={() => setCursor(startOfMonth(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)))} aria-label="Next month"><ChevronRight size={14} /></button>
            <div className="td-cal-month">{monthLabel}</div>
          </div>

          <div className="td-cal-controls">
            <select className="td-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="all">All roles</option>
              {scheduledRoleKeys().map((k) => <option key={k} value={k}>{assigneeRole(k).label}</option>)}
            </select>
            <select className="td-select" value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}>
              <option value="all">Everyone</option>
              {everyone.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="td-cal-modes">
              <button type="button" className={cls("td-cal-mode", mode === "month" && "active")} onClick={() => setMode("month")}>
                <LayoutGrid size={13} /> Month
              </button>
              <button type="button" className={cls("td-cal-mode", mode === "people" && "active")} onClick={() => setMode("people")}>
                <Users size={13} /> By person
              </button>
            </div>
          </div>
        </div>

        {inMonth.length === 0 ? (
          <EmptyState icon={CalendarIcon} title={"Nothing scheduled in " + monthLabel}
            sub="Assign an installer or a service crew on a job card and give them a date range — it shows up here." />
        ) : mode === "month" ? (
          <div className="td-cal-month-grid">
            <div className="td-cal-weekdays">
              {WEEKDAYS.map((d) => <div key={d}>{d}</div>)}
            </div>
            {weeks.map((w) => {
              const wEnd = addDaysTo(w, 6);
              const { segs, lanes } = segmentsFor(inMonth, w, wEnd);
              return (
                <div className="td-cal-week" key={+w}>
                  <div className="td-cal-days">
                    {WEEKDAYS.map((_, i) => {
                      const d = addDaysTo(w, i);
                      return (
                        <div key={i} className={cls("td-cal-day",
                          d.getMonth() !== monthStart.getMonth() && "td-cal-day-out",
                          sameDay(d, today) && "td-cal-day-today")}>
                          <span className="td-cal-daynum">{d.getDate()}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="td-cal-lanes" style={{ gridTemplateRows: "repeat(" + Math.max(lanes, 1) + ", auto)" }}>
                    {segs.map((s) => <Bar key={s.ev.id} s={s} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="td-cal-people-scroll">
            <div className="td-cal-people" style={{ "--days": daysInMonth }}>
              <div className="td-cal-people-row td-cal-people-head">
                <div className="td-cal-person-name" />
                <div className="td-cal-person-track td-cal-person-dates">
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const d = addDaysTo(monthStart, i);
                    return (
                      <div key={i} className={cls("td-cal-pday", sameDay(d, today) && "td-cal-day-today",
                        (d.getDay() === 0 || d.getDay() === 6) && "td-cal-pday-weekend")}>
                        <span>{WEEKDAYS[(d.getDay() + 6) % 7][0]}</span>
                        <strong>{d.getDate()}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>
              {peopleThisMonth.map((p) => {
                const mine = inMonth.filter((ev) => ev.person && ev.person.id === p.id);
                const { segs, lanes } = segmentsFor(mine, monthStart, monthEnd);
                return (
                  <div className="td-cal-people-row" key={p.id}>
                    <div className="td-cal-person-name">
                      <span className="td-cal-dot" style={{ background: p.color }} />
                      <span className="td-cal-person-label">{p.name}</span>
                    </div>
                    <div className="td-cal-person-track"
                      style={{ gridTemplateRows: "repeat(" + Math.max(lanes, 1) + ", auto)" }}>
                      {segs.map((s) => <Bar key={s.ev.id} s={s} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {popover && (
        <CalendarPopover ev={popover.ev} x={popover.x} y={popover.y}
          assigneeById={assigneeById}
          onClose={() => setPopover(null)}
          onOpenJob={() => { setSelectedJobId(popover.ev.job.id); setPopover(null); }} />
      )}
    </div>
  );
}

/**
 * The detail behind a block. A bar is too small to carry the job number, the
 * stage and who else is on site, so it carries the address and this carries
 * the rest.
 */
function CalendarPopover({ ev, x, y, assigneeById, onClose, onOpenJob }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("keydown", onKey);
    // Deferred: the click that opened this popover is still propagating, and
    // without the delay it closes itself on the way back up.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  const job = ev.job;
  const stage = STAGES.find((s) => s.key === job.stage);
  const others = (job.assignments || [])
    .filter((a) => a.id !== ev.assignment.id)
    .map((a) => ({ a, p: assigneeById.get(a.assigneeId) }))
    .filter((o) => o.p);

  // Keep it on screen when the bar that opened it sits near an edge.
  const left = Math.min(Math.max(8, x), (typeof window !== "undefined" ? window.innerWidth : 1200) - 308);
  const color = (ev.person && ev.person.color) || "#4A6070";

  return (
    <div className="td-cal-pop" ref={ref} style={{ left, top: y }} role="dialog">
      <div className="td-cal-pop-head">
        <span className="td-assign-chip" style={{ background: color, color: textOn(color) }}>
          {ev.person ? ev.person.name : "Unknown"}
        </span>
        <span className="td-cell-sub">{assigneeRole(ev.assignment.role).label}</span>
        <div style={{ flex: 1 }} />
        <IconBtn icon={X} title="Close" onClick={onClose} />
      </div>

      <div className="td-cal-pop-dates">
        <CalendarIcon size={13} /> {fmtDateRange(ev.assignment.startDate, ev.assignment.endDate)}
      </div>

      <div className="td-cal-pop-job">
        <div className="td-cal-pop-addr"><Building2 size={13} /> {job.customerAddress || "—"}</div>
        <div className="td-cell-sub">{job.customerName} · {jobRef(job)}</div>
        <div className="td-cal-pop-meta">
          <StatusPill>{stage ? stage.label : job.stage}</StatusPill>
          <span className="td-cal-pop-amt">{money(job.contractAmount)}</span>
        </div>
      </div>

      {others.length > 0 && (
        <div className="td-cal-pop-others">
          <span className="td-field-label">Also on this job</span>
          {others.map(({ a, p }) => (
            <div key={a.id} className="td-cal-pop-other">
              <span className="td-cal-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
              <span className="td-cell-sub">{assigneeRole(a.role).label}</span>
              {a.startDate && <span className="td-cell-sub">{fmtDateRange(a.startDate, a.endDate)}</span>}
            </div>
          ))}
        </div>
      )}

      <button className="td-btn td-btn-primary td-btn-sm td-cal-pop-open" onClick={onOpenJob}>
        Open job <ChevronRight size={13} />
      </button>
    </div>
  );
}

/* =========================================================================
   SCHEDULE MATCH REVIEW
   -------------------------------------------------------------------------
   A scheduled task reads the installer calendars and ties each event back to
   a job. Event titles are typed by people, so they come in every shape:
   "Solid Shield-Thompson Roof", "Mario - 1219 Winton Roof Install". When the
   task can narrow an event to several jobs but not one, it parks it here with
   its candidates.

   This page records which job was meant, and nothing else. It does not touch
   the job, the calendars or the CRM — the task does all of that on its next
   run, reading the decision made here. Keep it that way: a page that both
   decides and acts would double-apply the moment the task retried.
   ========================================================================= */

// Loose containment either way, so "Roof" matches "Roofing" and
// "27800 Parkview Dr" matches "27800 Parkview Dr, Euclid OH 44132". Only ever
// used to tint a field as corroborating — never to pick for anyone.
const looseHit = (a, b) => {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
};

function ScheduleReviewView({ ctx }) {
  const { reviewRows, reviewRecent, reviewLoading, reviewError, loadReview } = ctx;
  const [tab, setTab] = useState("pending");

  return (
    <div className="td-view">
      <style>{`
        .td-rev-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;}
        .td-rev-head p{margin:0;font-size:12.5px;line-height:1.5;color:#6E675C;max-width:70ch;flex-basis:100%;}
        .td-rev-card{border:1px solid #EBE6DC;border-radius:11px;background:#fff;
          padding:15px 16px;margin-bottom:13px;}
        .td-rev-title{font-size:15px;font-weight:650;line-height:1.35;word-break:break-word;}
        .td-rev-meta{display:flex;flex-wrap:wrap;gap:5px 11px;margin-top:4px;
          font-size:12px;color:#6E675C;}
        .td-rev-src{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;
          background:#EEF3F5;color:#3F6E80;font-size:11px;font-weight:650;letter-spacing:.03em;}
        .td-rev-parsed{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 3px;}
        .td-rev-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
          background:#F5F2EC;font-size:11.5px;color:#4A443B;}
        .td-rev-chip b{font-weight:650;color:#8A8478;font-weight:600;}
        .td-rev-cands{display:grid;gap:9px;margin-top:12px;
          grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}
        .td-rev-cand{text-align:left;border:1.5px solid #EBE6DC;border-radius:9px;background:#fff;
          padding:11px 12px;font:inherit;cursor:pointer;display:block;width:100%;}
        .td-rev-cand:hover{border-color:#C9C1B2;}
        .td-rev-cand.sel{border-color:#3F8EA6;background:#F2F8FA;}
        .td-rev-cand-name{font-size:13.5px;font-weight:650;}
        .td-rev-cand-row{font-size:12px;color:#6E675C;margin-top:3px;line-height:1.45;
          word-break:break-word;}
        .td-rev-hit{background:#E6EFE8;color:#2F6B46;border-radius:4px;padding:0 4px;font-weight:600;}
        .td-rev-open{display:inline-flex;align-items:center;gap:4px;margin-top:7px;
          font-size:11.5px;color:#3F6E80;background:none;border:none;padding:0;cursor:pointer;}
        .td-rev-none{margin-top:9px;}
        .td-rev-empty{margin-top:10px;padding:9px 12px;border-radius:8px;background:#FDF3E3;
          color:#8A5A12;font-size:12.5px;line-height:1.5;}
        .td-rev-actions{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:13px;
          padding-top:12px;border-top:1px solid #F0ECE3;}
        .td-rev-msg{font-size:12px;flex-basis:100%;}
        .td-rev-msg-err{color:#9B3A20;}
        .td-rev-msg-ok{color:#2F6B46;}
        .td-rev-recent{width:100%;border-collapse:collapse;}
        .td-rev-recent td,.td-rev-recent th{text-align:left;font-size:12.5px;padding:9px 10px 9px 0;
          border-bottom:1px solid #F0ECE3;vertical-align:top;}
        .td-rev-recent th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8A8478;}
        .td-rev-stale{color:#8A5A12;font-size:11.5px;}
        @media (max-width:560px){
          .td-rev-cands{grid-template-columns:1fr;}
          .td-rev-actions .td-btn{flex:1;justify-content:center;}
        }
      `}</style>

      <div className="td-rev-head">
        <div className="td-segment">
          <button className={cls("td-segment-btn", tab === "pending" && "active")}
            onClick={() => setTab("pending")}>
            Needs a decision{reviewRows.length ? " (" + reviewRows.length + ")" : ""}
          </button>
          <button className={cls("td-segment-btn", tab === "recent" && "active")}
            onClick={() => setTab("recent")}>Recent</button>
        </div>
        <button className="td-btn td-btn-sm" onClick={loadReview} disabled={reviewLoading}>
          <RefreshCw size={13} className={cls(reviewLoading && "td-spin")} /> Refresh
        </button>
        <p>
          Calendar events the sync could not tie to one job. Picking the right job here is
          all this page does — the scheduled task reads the decision on its next run and
          does the scheduling.
        </p>
      </div>

      {reviewError && <div className="td-access-err"><AlertTriangle size={14} /> {reviewError}</div>}

      {tab === "pending" ? (
        reviewLoading && reviewRows.length === 0 ? (
          <div className="td-muted-line"><RefreshCw size={13} className="td-spin" /> Loading…</div>
        ) : reviewRows.length === 0 ? (
          <EmptyState icon={CalendarCheck} title="Nothing waiting"
            sub="Every calendar event matched a job on its own." />
        ) : reviewRows.map((row) => (
          <ScheduleReviewRow key={row.id} ctx={ctx} row={row} />
        ))
      ) : (
        <ScheduleReviewRecent ctx={ctx} rows={reviewRecent} />
      )}
    </div>
  );
}

function ScheduleReviewRow({ ctx, row }) {
  const [picked, setPicked] = useState(null); // job_id | "__none"
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);       // { text, err }
  const empty = row.candidates.length === 0;

  const confirm = async () => {
    if (!picked || busy) return;
    setBusy(true); setMsg(null);
    try {
      const saved = await repo.resolveScheduleReview(row.id, picked === "__none" ? null : picked);
      if (!saved) {
        // Someone else decided it, or the task moved it on. Saying "saved"
        // here would be a lie the next run would expose.
        setMsg({ text: "This one was already handled or the event changed — refreshing.", err: true });
        await ctx.loadReview();
        return;
      }
      await ctx.loadReview();
    } catch (e) {
      setMsg({ text: e && e.message ? e.message : "That could not be saved.", err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="td-rev-card">
      <div className="td-rev-title">{row.eventTitle}</div>
      <div className="td-rev-meta">
        <span className="td-rev-src">{row.source === "ghl" ? "GHL" : "GOOGLE"}</span>
        <span>{row.eventStart ? fmtDateTime(row.eventStart) : "no date on the event"}</span>
        {row.otherEventId && <span>· linked to the other calendar</span>}
      </div>

      <div className="td-rev-parsed">
        {[["Installer", row.parsed.installer], ["Customer", row.parsed.customer],
          ["Address", row.parsed.address], ["Job type", row.parsed.jobType]]
          .filter(([, v]) => v)
          .map(([k, v]) => <span key={k} className="td-rev-chip"><b>{k}</b> {v}</span>)}
        {!row.parsed.installer && !row.parsed.customer && !row.parsed.address && !row.parsed.jobType && (
          <span className="td-rev-chip">nothing could be read out of the title</span>
        )}
      </div>

      {empty ? (
        <div className="td-rev-empty">
          No job in TradeDesk looked like a match for this event. Marking it "none of these"
          tells the sync to leave it alone.
        </div>
      ) : (
        <div className="td-rev-cands">
          {row.candidates.map((c, i) => (
            <ScheduleReviewCandidate key={c.job_id || i} ctx={ctx} c={c} parsed={row.parsed}
              selected={picked === c.job_id} onPick={() => setPicked(c.job_id)} />
          ))}
        </div>
      )}

      <div className="td-rev-none">
        <button type="button"
          className={cls("td-rev-cand", picked === "__none" && "sel")}
          onClick={() => setPicked("__none")}>
          <span className="td-rev-cand-name">None of these</span>
          <span className="td-rev-cand-row">Leave this event unscheduled and out of the sync.</span>
        </button>
      </div>

      <div className="td-rev-actions">
        <button className="td-btn td-btn-primary td-btn-sm" onClick={confirm} disabled={!picked || busy}>
          {busy ? <RefreshCw size={13} className="td-spin" /> : <Check size={13} />} Confirm
        </button>
        {picked && !busy && (
          <button className="td-btn td-btn-sm td-btn-ghost" onClick={() => setPicked(null)}>Clear</button>
        )}
        {msg && <div className={cls("td-rev-msg", msg.err ? "td-rev-msg-err" : "td-rev-msg-ok")}>{msg.text}</div>}
      </div>
    </div>
  );
}

function ScheduleReviewCandidate({ ctx, c, parsed, selected, onPick }) {
  // Only offer to open a job this browser actually has; a candidate the task
  // wrote for a job since deleted would otherwise open an empty modal.
  const known = ctx.jobs.some((j) => j.id === c.job_id);
  const hit = (field, against) => looseHit(field, against);

  return (
    <div className={cls("td-rev-cand", selected && "sel")} onClick={onPick}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}>
      <div className="td-rev-cand-name">
        <span className={cls(hit(c.customer_name, parsed.customer) && "td-rev-hit")}>
          {c.customer_name || "(no name)"}
        </span>
      </div>
      {c.address && (
        <div className="td-rev-cand-row">
          <span className={cls(hit(c.address, parsed.address) && "td-rev-hit")}>{c.address}</span>
        </div>
      )}
      <div className="td-rev-cand-row">
        {c.job_number ? "Job " + c.job_number : "no job number"}
        {c.job_type ? " · " : ""}
        {c.job_type && (
          <span className={cls(hit(c.job_type, parsed.jobType) && "td-rev-hit")}>{c.job_type}</span>
        )}
      </div>
      {(c.assigned_installer || c.scheduled_date) && (
        <div className="td-rev-cand-row">
          {c.assigned_installer && (
            <span className={cls(hit(c.assigned_installer, parsed.installer) && "td-rev-hit")}>
              {c.assigned_installer}
            </span>
          )}
          {c.assigned_installer && c.scheduled_date ? " · " : ""}
          {c.scheduled_date && fmtDateNum(c.scheduled_date)}
        </div>
      )}
      {known && (
        <button type="button" className="td-rev-open"
          onClick={(e) => { e.stopPropagation(); ctx.setSelectedJobId(c.job_id); }}>
          <ExternalLink size={11} /> Open this job
        </button>
      )}
    </div>
  );
}

function ScheduleReviewRecent({ ctx, rows }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const undo = async (row) => {
    setBusy(row.id); setErr("");
    try {
      const back = await repo.undoScheduleReview(row.id);
      if (!back) setErr("That one has already been carried out, so it cannot be undone.");
      await ctx.loadReview();
    } catch (e) {
      setErr(e && e.message ? e.message : "That could not be undone.");
    } finally {
      setBusy("");
    }
  };

  if (rows.length === 0) {
    return <EmptyState icon={CalendarCheck} title="Nothing in the last 14 days" />;
  }

  const label = { resolved: "Matched", no_match: "No match", applied: "Scheduled", stale: "Stale" };

  return (
    <div className="td-panel">
      {err && <div className="td-access-err"><AlertTriangle size={14} /> {err}</div>}
      <table className="td-rev-recent">
        <thead>
          <tr><th>Event</th><th>Decision</th><th>Who</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{r.eventTitle}</div>
                <div className="td-cell-sub">
                  {r.source === "ghl" ? "GHL" : "Google"}
                  {r.eventStart ? " · " + fmtDateTime(r.eventStart) : ""}
                </div>
                {r.status === "stale" && (
                  <div className="td-rev-stale">
                    The calendar event changed after this was queued — it will be re-checked
                    on the next run.
                  </div>
                )}
              </td>
              <td>
                {label[r.status] || r.status}
                {r.appliedAt && <div className="td-cell-sub">carried out {fmtDate(r.appliedAt)}</div>}
              </td>
              <td>
                {r.resolvedBy || "—"}
                {r.resolvedAt && <div className="td-cell-sub">{fmtDate(r.resolvedAt)}</div>}
              </td>
              <td>
                {/* Undo is gone the moment the task has acted: the schedule is
                    out in the world by then and this page cannot pull it back. */}
                {!r.appliedAt && (r.status === "resolved" || r.status === "no_match") && (
                  <button className="td-btn td-btn-sm td-btn-ghost" disabled={busy === r.id}
                    onClick={() => undo(r)}>
                    {busy === r.id ? <RefreshCw size={12} className="td-spin" /> : null} Undo
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* =========================================================================
   ACCESS — who can sign in, and what they get
   -------------------------------------------------------------------------
   Visible only to a super administrator, and only because the Access item is
   left out of the nav for everyone else. That is not the control: every
   function this screen calls checks is_super_admin() in Postgres and raises
   42501 otherwise, and user_roles is writable by nobody else at all. The anon
   key ships inside the browser bundle, so a screen is never a permission.

   Two things are set here, and they do different jobs:

     Role   — what the person can see. 'admin' is the office: every job, every
              payment, the reports. 'project_manager' is their own jobs only,
              with the contract amount but no other money.
     Person — which name on the assignment lists is this login. can_see_job()
              matches on exactly that, so a project manager with nobody linked
              sees an empty board, which is why that case is called out below.
   ========================================================================= */

function AccessView({ ctx }) {
  const { assignees, reload } = ctx;
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [ghlUsers, setGhlUsers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = React.useCallback(async () => {
    try {
      const [u, r, g] = await Promise.all([
        repo.listUsers(), repo.listAppRoles(),
        // The GHL directory is optional: if it cannot be read the rest of the
        // screen still works, it just has no GoHighLevel names to offer.
        repo.listGhlUsers().catch(() => []),
      ]);
      setUsers(u);
      setRoles(r);
      setGhlUsers(g || []);
      setErr("");
    } catch (e) {
      setUsers([]);
      setErr(e && e.message ? e.message : "Could not read the user list.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Every change here alters what somebody else is allowed to load, so the
  // whole app is re-read afterwards rather than patched in place — including
  // this user's own role, which they can lower but (by the database guard)
  // never to the point of leaving nobody in charge.
  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
      await load();
      await reload();
      setErr("");
    } catch (e) {
      setErr(e && e.message ? e.message : "That change was refused.");
    } finally {
      setBusy("");
    }
  };

  const unlinked = assignees.filter((a) => !a.userId && a.active !== false);
  // GoHighLevel side: which GHL person opens TradeDesk from the sidebar as
  // which login. 'linked' was set here or by a past sign-in; 'email' is the
  // automatic match td-sso will make on first visit. A login holds one GHL user.
  const ghlOf = (userId) => ghlUsers.filter((g) => g.user_id === userId);
  const ghlPickable = ghlUsers.filter((g) => !g.deleted && g.link_kind !== "linked");
  const emailOf = (userId) => ((users || []).find((x) => x.user_id === userId) || {}).email || "";
  const refreshGhl = () => run("ghl-refresh", async () => {
    await repo.refreshGhlUsers();
    await new Promise((r) => setTimeout(r, 4000));
  });
  const linkedTo = (userId) => assignees.filter((a) => a.userId === userId);
  const roleLabel = (key) => (roles.find((r) => r.key === key) || {}).label || key;

  return (
    <div className="td-view">
      <style>{`
        .td-access-head{margin-bottom:14px;}
        .td-access-head h2{margin:0 0 4px;font-size:16px;font-weight:650;}
        .td-access-head p{margin:0;font-size:12.5px;line-height:1.5;color:#6E675C;max-width:66ch;}
        .td-access-user{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;
          padding:13px 15px;border-bottom:1px solid #EBE6DC;}
        .td-access-user:last-child{border-bottom:none;}
        .td-access-who{min-width:230px;flex:1;}
        .td-access-email{font-size:13.5px;font-weight:600;word-break:break-all;}
        .td-access-seen{font-size:11.5px;color:#8A8478;margin-top:2px;}
        .td-access-people{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:2;min-width:260px;}
        .td-access-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 6px 3px 9px;
          border-radius:999px;font-size:11.5px;font-weight:600;color:#fff;}
        .td-access-chip button{border:none;background:transparent;color:inherit;cursor:pointer;
          padding:0;display:inline-flex;opacity:.75;}
        .td-access-chip button:hover{opacity:1;}
        .td-access-ghl{background:#2F5D8A;color:#fff;}
        .td-access-warn{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;
          color:#9B3A20;background:#FBEDE9;border-radius:6px;padding:3px 8px;}
        .td-access-err{display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:9px 12px;
          border-radius:8px;background:#FBEDE9;color:#9B3A20;font-size:12.5px;}
        .td-access-foot{margin-top:14px;font-size:12px;line-height:1.6;color:#6E675C;}
        .td-access-foot strong{color:#3A352E;}
      `}</style>

      <div className="td-access-head">
        <h2>Access</h2>
        <p>
          Who can sign in to TradeDesk and what they get once they do. Office staff see
          everything; a project manager sees only the jobs they are assigned to, with the
          contract amount but no payments, margin or reports. Accounts themselves are created
          in Supabase — this is where they are given a role and matched to a name.
        </p>
      </div>

      {err && <div className="td-access-err"><AlertTriangle size={14} /> {err}</div>}

      <div className="td-panel">
        {users === null ? (
          <div className="td-muted-line" style={{ padding: 16 }}><RefreshCw size={13} className="td-spin" /> Loading…</div>
        ) : users.length === 0 ? (
          <EmptyState icon={Users} title="No sign-ins found" sub="Accounts are created in Supabase Authentication." />
        ) : users.map((u) => {
          const mine = linkedTo(u.user_id);
          const blind = u.role === "project_manager" && mine.length === 0;
          return (
            <div className="td-access-user" key={u.user_id}>
              <div className="td-access-who">
                <div className="td-access-email">{u.email}</div>
                <div className="td-access-seen">
                  {u.last_sign_in_at ? "last signed in " + timeAgo(u.last_sign_in_at) : "has never signed in"}
                </div>
              </div>

              <select className="td-select" style={{ minWidth: 165 }}
                value={u.role}
                disabled={busy === u.user_id}
                onChange={(e) => run(u.user_id, () => repo.setUserRole(u.user_id, e.target.value))}>
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>

              <div className="td-access-people">
                {ghlOf(u.user_id).map((g) => (
                  <span key={"ghl-" + g.ghl_user_id} className="td-access-chip td-access-ghl"
                    title={g.link_kind === "linked"
                      ? "GoHighLevel user " + (g.email || "") + " signs in as this login"
                      : "Matched by email — signs in as this login on first visit from GoHighLevel"}>
                    <Link2 size={11} /> {g.name || g.email}{g.link_kind === "email" ? " (email)" : ""}
                    {g.link_kind === "linked" && (
                      <button type="button" title="Unlink GoHighLevel user"
                        onClick={() => run("ghl-" + g.ghl_user_id, () => repo.linkGhlUser(g.ghl_user_id, null))}>
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}

                {mine.map((a) => (
                  <span key={a.id} className="td-access-chip"
                    style={{ background: a.color, color: textOn(a.color) }}
                    title={assigneeRole(a.role).label}>
                    {a.name}
                    <button type="button" title="Unlink"
                      onClick={() => run("link-" + a.id, () => repo.linkAssignee(a.id, null))}>
                      <X size={11} />
                    </button>
                  </span>
                ))}

                <select className="td-select" style={{ minWidth: 170 }} value=""
                  disabled={busy !== ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    if (id.startsWith("ghl:")) {
                      const gid = id.slice(4);
                      run("ghl-" + gid, () => repo.linkGhlUser(gid, u.user_id));
                    } else run("link-" + id, () => repo.linkAssignee(id, u.user_id));
                  }}>
                  <option value="">Link a name…</option>
                  {!ghlOf(u.user_id).some((g) => g.link_kind === "linked") && ghlPickable.length > 0 && (
                    <optgroup label="GoHighLevel user">
                      {ghlPickable.map((g) => (
                        <option key={g.ghl_user_id} value={"ghl:" + g.ghl_user_id}>
                          {g.name || g.email}{g.email ? " — " + g.email : ""}
                          {g.user_id && g.user_id !== u.user_id ? " (now: " + emailOf(g.user_id) + ")" : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {assigneeRoleKeys().map((rk) => {
                    const opts = unlinked.filter((a) => a.role === rk);
                    if (!opts.length) return null;
                    return (
                      <optgroup key={rk} label={assigneeRole(rk).label}>
                        {opts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </optgroup>
                    );
                  })}
                </select>

                {blind && (
                  <span className="td-access-warn" title="can_see_job() matches on the linked name">
                    <AlertTriangle size={11} /> no name linked — sees no jobs
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="td-access-head" style={{ marginTop: 22, display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2>GoHighLevel users</h2>
          <p>
            Everyone in the Renew sub-account, refreshed nightly. Opening TradeDesk from the GoHighLevel
            sidebar signs a person in as the login shown here — matched by email unless linked above with
            “Link a name…”. Anyone without a login is refused.
          </p>
        </div>
        <button className="td-btn td-btn-sm" onClick={refreshGhl} disabled={busy !== ""}>
          <RefreshCw size={13} className={busy === "ghl-refresh" ? "td-spin" : ""} /> Refresh from GoHighLevel
        </button>
      </div>

      <div className="td-panel">
        {ghlUsers.length === 0 ? (
          <div className="td-muted-line" style={{ padding: 16 }}>
            No GoHighLevel users loaded yet. Use “Refresh from GoHighLevel”.
          </div>
        ) : (
          <div className="td-table-wrap">
            <table className="td-table">
              <thead>
                <tr><th>Name</th><th>GoHighLevel email</th><th>GHL role</th><th>Signs in as</th></tr>
              </thead>
              <tbody>
                {ghlUsers.map((g) => (
                  <tr key={g.ghl_user_id} style={g.deleted ? { opacity: 0.5 } : undefined}>
                    <td>{g.name || "—"}{g.deleted ? " (removed)" : ""}</td>
                    <td style={{ wordBreak: "break-all" }}>{g.email || "—"}</td>
                    <td>{[g.ghl_type, g.ghl_role].filter(Boolean).join(" · ") || "—"}</td>
                    <td>
                      {g.user_id ? (
                        <>{emailOf(g.user_id)} <span className="td-access-seen" style={{ display: "inline" }}>
                          {g.link_kind === "linked" ? "· linked" : "· by email"}</span></>
                      ) : (
                        <span className="td-access-warn"><AlertTriangle size={11} /> no TradeDesk login — refused</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="td-access-foot">
        <strong>{roleLabel("super_admin")}</strong> is the only role that can open this screen or
        change a role, and the database refuses the change that would leave nobody holding it.
        Hiding a tab is not access control: the same rules run in Postgres, so a restricted login
        is refused the rows even if it talks to the database directly.
      </div>
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

      .td-root {
        --td-ink: #1B2027;
        --td-ink-border: #333B47;
        --td-ink-text: #E9E4D8;
        --td-ink-muted: #929BA8;
        --td-paper: #F3EFE6;
        --td-card: #FFFFFF;
        --td-border: #E1D8C4;
        --td-track: #EAE3D2;
        --td-text: #221E17;
        --td-muted: #6E6759;
        --td-accent: #D9531E;
        --td-amber: #B8860B;
        --td-green: #3F7D58;
        --td-red: #B23A2E;
        --td-radius: 5px;
        font-family: 'Inter', -apple-system, sans-serif;
        color: var(--td-text);
        background: var(--td-paper);
        width: 100%;
        min-height: 100vh;
        box-sizing: border-box;
      }
      .td-root *, .td-root *::before, .td-root *::after { box-sizing: border-box; }
      .td-root button, .td-root input, .td-root select, .td-root textarea { font-family: inherit; font-size: inherit; color: inherit; }
      .td-root :focus-visible { outline: 2px solid var(--td-accent); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { .td-root * { animation: none !important; transition: none !important; } }

      .td-loading-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 10px; color: var(--td-muted); font-size: 13px; }
      .td-spin { animation: td-spin 1s linear infinite; color: var(--td-accent); }
      @keyframes td-spin { to { transform: rotate(360deg); } }

      /* ---------- Shell ---------- */
      /* No reset existed, so the browser's default 8px body margin sat under a
         100vh shell and gave the page 16px of scroll. Small, but it is enough
         to drag the board's horizontal scrollbar off the bottom of the screen. */
      html, body { margin: 0; padding: 0; height: 100%; }
      #root { height: 100%; }
      /* 100dvh rather than 100vh: on mobile, vh is the tallest possible
         viewport, so with the browser chrome showing the board's scrollbar
         ends up just off the bottom of the screen. dvh tracks the real one.
         The safe-area insets keep content clear of the notch and the home
         indicator when the app is installed and running standalone. */
      .td-shell { display: flex; height: 100vh; height: 100dvh; min-height: 560px;
        box-sizing: border-box;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
      .td-sidebar { width: 216px; flex: none; background: var(--td-ink); color: var(--td-ink-text); display: flex; flex-direction: column; padding: 18px 14px; border-right: 1px solid var(--td-ink-border); }
      .td-brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 20px; }
      .td-brand-mark { width: 30px; height: 30px; border-radius: 4px; background: var(--td-accent); color: #fff; display: flex; align-items: center; justify-content: center; flex: none; }
      .td-brand-name { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 16px; letter-spacing: 0.02em; line-height: 1.1; }
      .td-brand-tag { font-size: 10px; color: var(--td-ink-muted); letter-spacing: 0.02em; margin-top: 2px; }
      .td-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .td-nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: none; background: transparent; color: var(--td-ink-muted); border-radius: 4px; cursor: pointer; text-align: left; font-size: 13px; font-weight: 500; border-left: 2px solid transparent; }
      .td-nav-item:hover { background: rgba(255,255,255,0.05); color: var(--td-ink-text); }
      .td-nav-item.active { background: rgba(217,83,30,0.14); color: #fff; border-left: 2px solid var(--td-accent); }
      .td-sidebar-foot { border-top: 1px solid var(--td-ink-border); padding-top: 12px; margin-top: 12px; }
      .td-trade-legend-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--td-ink-muted); margin-bottom: 8px; }
      .td-trade-legend { display: flex; flex-wrap: wrap; gap: 6px; }
      .td-legend-chip { width: 22px; height: 22px; border-radius: 4px; background: rgba(255,255,255,0.06); border: 1px solid var(--td-ink-border); color: var(--tc); display: flex; align-items: center; justify-content: center; }

      .td-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .td-topbar { display: flex; align-items: center; gap: 14px; padding: 12px 22px; background: var(--td-ink); border-bottom: 1px solid var(--td-ink-border); color: var(--td-ink-text); }
      .td-hamburger { display: none; background: none; border: none; color: var(--td-ink-text); cursor: pointer; padding: 4px; }
      .td-topbar-title { font-family: 'Oswald', sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
      .td-topbar-search { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.07); border: 1px solid var(--td-ink-border); border-radius: 4px; padding: 7px 10px; flex: 1; max-width: 380px; color: var(--td-ink-muted); }
      .td-topbar-search input { background: none; border: none; outline: none; color: var(--td-ink-text); width: 100%; }
      .td-topbar-search input::placeholder { color: var(--td-ink-muted); }
      /* min-height:0 lets a flex child actually shrink, which is what allows the
         board below to bound itself to the viewport instead of growing the page. */
      .td-content { flex: 1; overflow-y: auto; padding: 22px; display: flex; flex-direction: column; min-height: 0; }
      .td-view { display: flex; flex-direction: column; gap: 18px; }
      .td-view-flush { gap: 14px; flex: 1; min-height: 0; }

      /* ---------- Buttons / inputs ---------- */
      .td-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 13px; border-radius: 4px; border: 1px solid var(--td-border); background: var(--td-card); color: var(--td-text); font-size: 13px; font-weight: 500; cursor: pointer; }
      .td-btn:hover { border-color: #C9BDA0; }
      .td-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .td-btn-primary { background: var(--td-accent); border-color: var(--td-accent); color: #fff; }
      .td-btn-primary:hover { background: #C24916; border-color: #C24916; }
      .td-btn-danger { color: var(--td-red); border-color: #E2B8AE; background: #FBF1EE; }
      .td-btn-danger:hover { background: #F6E2DC; }
      .td-btn-sm { padding: 5px 9px; font-size: 12px; }
      .td-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--td-border); background: var(--td-card); color: var(--td-muted); cursor: pointer; flex: none; }
      .td-iconbtn:hover { border-color: #C9BDA0; color: var(--td-text); }
      .td-iconbtn-danger:hover { color: var(--td-red); border-color: #E2B8AE; }
      .td-link-btn { display: inline-flex; align-items: center; gap: 3px; background: none; border: none; color: var(--td-accent); font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 2px; }
      .td-toggle-chip { display: inline-flex; align-items: center; gap: 5px; padding: 7px 11px; border-radius: 4px; border: 1px solid var(--td-border); background: var(--td-card); color: var(--td-muted); font-size: 12.5px; cursor: pointer; white-space: nowrap; }
      .td-toggle-chip.active { background: #E1EEE4; border-color: #BEDAC7; color: var(--td-green); }

      .td-input, .td-select, .td-textarea { width: 100%; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--td-border); background: var(--td-card); color: var(--td-text); font-size: 13px; }
      .td-input:focus, .td-select:focus, .td-textarea:focus { border-color: var(--td-accent); }
      .td-textarea { resize: vertical; font-family: inherit; }
      .td-select { cursor: pointer; }
      .td-select-full { width: 100%; }
      .td-input-num { text-align: right; }

      .td-field { display: flex; flex-direction: column; gap: 5px; }
      .td-field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--td-muted); font-weight: 600; }
      .td-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

      /* ---------- Modal ---------- */
      .td-modal-veil { position: fixed; inset: 0; background: rgba(20,17,10,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
      .td-modal { background: var(--td-paper); border-radius: 8px; width: 100%; max-width: 460px; max-height: 88vh; display: flex; flex-direction: column; box-shadow: 0 24px 60px rgba(15,12,6,0.35); }
      .td-modal-wide { max-width: 780px; }
      .td-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--td-border); font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 15px; letter-spacing: 0.01em; }
      .td-modal-close { background: none; border: none; cursor: pointer; color: var(--td-muted); padding: 4px; }
      .td-modal-body { padding: 18px 20px; overflow-y: auto; }
      .td-modal-foot { display: flex; align-items: center; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--td-border); }

      .td-drawer-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--td-muted); font-weight: 700; margin-bottom: 9px; border-top: 1px dashed var(--td-border); padding-top: 14px; }
      .td-muted-line { font-size: 12.5px; color: var(--td-muted); font-style: italic; }
      .td-info-row { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--td-text); margin-bottom: 4px; }
      .td-info-row svg { color: var(--td-muted); flex: none; }
      .td-comm-icon { width: 24px; height: 24px; border-radius: 50%; background: var(--td-track); color: var(--td-muted); display: flex; align-items: center; justify-content: center; flex: none; }

      /* ---------- Badges / pills ---------- */
      .td-trade-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 20px; background: color-mix(in srgb, var(--tc) 12%, white); color: var(--tc); font-size: 12px; font-weight: 600; border: 1px solid color-mix(in srgb, var(--tc) 30%, white); white-space: nowrap; }
      .td-trade-badge-sm { padding: 3px 8px; font-size: 11px; }
      .td-pill { display: inline-block; padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
      .td-pill-neutral { background: var(--td-track); color: var(--td-muted); }
      .td-pill-green { background: #E1EEE4; color: var(--td-green); }
      .td-pill-amber { background: #F3E7C9; color: #8A6A0B; }
      .td-pill-red { background: #F4DBD6; color: var(--td-red); }
      .td-text-red { color: var(--td-red); font-weight: 600; }
      .td-text-green { color: var(--td-green); font-weight: 600; }

      /* ---------- Stat cards ---------- */
      .td-stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .td-ticket-stat { background: var(--td-card); border: 1px solid var(--td-border); border-left: 3px solid var(--tc); border-radius: var(--td-radius); padding: 13px 14px; }
      .td-ticket-stat-top { display: flex; align-items: center; justify-content: space-between; color: var(--tc); margin-bottom: 8px; }
      .td-ticket-stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--td-muted); font-weight: 700; }
      .td-ticket-stat-value { font-family: 'Oswald', sans-serif; font-size: 22px; font-weight: 600; line-height: 1; }
      .td-ticket-stat-foot { font-size: 11.5px; color: var(--td-muted); margin-top: 6px; }

      .td-dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .td-panel { background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius); padding: 14px 16px; }
      .td-panel-head { display: flex; align-items: center; justify-content: space-between; font-family: 'Oswald', sans-serif; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; margin-bottom: 12px; }
      .td-list { display: flex; flex-direction: column; gap: 3px; }
      .td-list-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 6px; background: none; border: none; border-radius: 4px; cursor: pointer; text-align: left; }
      .td-list-row:hover { background: var(--td-paper); }
      .td-list-row-main { flex: 1; min-width: 0; }
      .td-list-row-title { font-size: 12.5px; font-weight: 600; }
      .td-list-row-sub { font-size: 11.5px; color: var(--td-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .td-list-row-end { font-size: 11px; color: var(--td-muted); font-family: 'IBM Plex Mono', monospace; flex: none; }

      /* ---------- Charts ---------- */
      .td-barchart { display: flex; flex-direction: column; gap: 9px; }
      .td-barrow { display: grid; grid-template-columns: 130px 1fr 64px; align-items: center; gap: 8px; }
      .td-barrow-label { font-size: 11.5px; color: var(--td-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .td-barrow-track { height: 9px; background: var(--td-track); border-radius: 3px; overflow: hidden; }
      .td-barrow-fill { height: 100%; border-radius: 3px; }
      .td-barrow-value { font-size: 11.5px; font-family: 'IBM Plex Mono', monospace; text-align: right; }
      .td-donut-wrap { position: relative; margin: 0 auto; }
      .td-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .td-donut-total { font-family: 'Oswald', sans-serif; font-size: 22px; font-weight: 600; }
      .td-donut-total-label { font-size: 10px; color: var(--td-muted); text-transform: uppercase; letter-spacing: 0.05em; }

      /* ---------- Progress bar ---------- */
      .td-progress-track { height: 7px; background: var(--td-track); border-radius: 4px; overflow: hidden; margin: 10px 0 16px; }
      .td-progress-fill { height: 100%; background: var(--td-accent); border-radius: 4px; transition: width 0.2s ease; }
      .td-progress-green { background: var(--td-green); }

      /* ---------- Tables ---------- */
      .td-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .td-filter-group { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      /* .td-select is width:100% for form fields, which in a flex row forces
         every control onto its own line. Toolbar and detail-header controls
         size to their content instead. */
      .td-filter-group .td-select, .td-deal-modal-row .td-select { width: auto; min-width: 140px; }
      .td-table-wrap { background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius); overflow: hidden; overflow-x: auto; }
      .td-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .td-table thead th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--td-muted); padding: 10px 14px; background: var(--td-paper); border-bottom: 1px solid var(--td-border); white-space: nowrap; }
      .td-table td { padding: 11px 14px; border-bottom: 1px solid var(--td-border); vertical-align: middle; }
      .td-table-row { cursor: pointer; }
      .td-table-row:hover { background: #FBF8F1; }
      .td-table tbody tr:last-child td { border-bottom: none; }
      .td-cell-name { font-weight: 600; }
      .td-cell-sub { color: var(--td-muted); font-size: 12px; display: flex; align-items: center; gap: 3px; }
      /* On a <td>, flex would break it out of the table layout and misalign the row divider. */
      td.td-cell-sub { display: table-cell; }
      .td-mono { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }

      .td-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 50px 20px; color: var(--td-muted); text-align: center; background: var(--td-card); border: 1px dashed var(--td-border); border-radius: var(--td-radius); }
      .td-empty-title { font-weight: 600; font-size: 13.5px; color: var(--td-text); }
      .td-empty-sub { font-size: 12px; max-width: 280px; }

      /* ---------- Kanban / tickets ---------- */
      .td-segment { display: inline-flex; border: 1px solid var(--td-border); border-radius: 4px; overflow: hidden; }
      .td-segment-btn { padding: 7px 13px; background: var(--td-card); border: none; border-right: 1px solid var(--td-border); font-size: 12.5px; font-weight: 500; cursor: pointer; color: var(--td-muted); }
      .td-segment-btn:last-child { border-right: none; }
      .td-segment-btn.active { background: var(--td-ink); color: #fff; }

      /* The board scrolls sideways within the viewport, so the horizontal
         scrollbar is always reachable. Previously the columns grew to their
         content, the page grew with them, and the only way to the scrollbar was
         to scroll to the bottom of the longest column. Each column now scrolls
         its own cards vertically instead. */
      .td-kanban { display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden;
        align-items: stretch; flex: 1; min-height: 0; padding-bottom: 4px; overscroll-behavior-x: contain; }
      .td-kanban-col { flex: none; width: 230px; background: #EAE4D4; border: 1px solid var(--td-border);
        border-radius: var(--td-radius); padding: 10px; min-height: 120px;
        display: flex; flex-direction: column; max-height: 100%; }
      .td-kanban-col-over { outline: 2px dashed var(--td-accent); outline-offset: -2px; }
      .td-kanban-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; color: var(--td-muted); padding: 2px 2px 0; }
      .td-kanban-count { background: rgba(0,0,0,0.08); border-radius: 10px; padding: 1px 7px; font-size: 10.5px; }
      .td-kanban-col-total { font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600; padding: 4px 2px 10px; color: var(--td-text); }
      .td-kanban-col-body { display: flex; flex-direction: column; gap: 8px; min-height: 40px;
        flex: 1; overflow-y: auto; overscroll-behavior-y: contain; padding-right: 2px; }
      /* A visible track beats an invisible one you have to hunt for. */
      .td-kanban { scrollbar-width: auto; }
      .td-kanban::-webkit-scrollbar { height: 12px; }
      .td-kanban::-webkit-scrollbar-track { background: rgba(0,0,0,0.05); border-radius: 6px; }
      .td-kanban::-webkit-scrollbar-thumb { background: #BFB6A4; border-radius: 6px; border: 3px solid transparent; background-clip: content-box; }
      .td-kanban::-webkit-scrollbar-thumb:hover { background: #A69C88; background-clip: content-box; }
      .td-kanban-col-body::-webkit-scrollbar { width: 8px; }
      .td-kanban-col-body::-webkit-scrollbar-thumb { background: #C9C0AE; border-radius: 4px; }
      .td-select-on { background: #E9EFF3; border-color: #A9C3D2; }

      .td-ticket { position: relative; background: var(--td-card); border: 1px solid var(--td-border); border-left: 3px solid var(--tc); border-radius: 4px; padding: 10px 11px; cursor: grab; box-shadow: 0 1px 2px rgba(20,16,8,0.06); }
      .td-ticket:active { cursor: grabbing; }
      .td-ticket-dragging { opacity: 0.5; }
      .td-ticket-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
      .td-ticket-no { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--td-muted); letter-spacing: 0.02em; }
      .td-ticket-title { font-size: 12.5px; font-weight: 600; line-height: 1.3; margin-bottom: 4px; }
      .td-ticket-contact { font-size: 11.5px; color: var(--td-muted); margin-bottom: 8px; }
      .td-ticket-foot { display: flex; align-items: center; justify-content: space-between; border-top: 1px dashed var(--td-border); padding-top: 7px; }
      .td-ticket-value { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; font-weight: 700; color: var(--td-text); }
      .td-ticket-date { font-size: 10.5px; color: var(--td-muted); }
      .td-ticket-flags { display: flex; flex-direction: column; gap: 3px; margin-top: 7px; }
      .td-ticket-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; width: fit-content; }
      .td-ticket-flag-red { background: #F4DBD6; color: var(--td-red); }
      .td-ticket-flag-amber { background: #F3E7C9; color: #8A6A0B; }
      .td-ticket-flag-green { background: #DCE9DA; color: #3E6B3A; }
      .td-ticket-flag-neutral { background: #EFEBE3; color: #6B6459; }
      .td-paidstatus { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
      .td-paidstatus-opts { display: flex; flex-wrap: wrap; gap: 8px; }
      .td-hold-toggle.td-paidstatus-on { background: #DCE9DA; border-color: #A9C9A4; color: #3E6B3A; }
      .td-ticket-flag-repair { background: #E2E4EE; color: #4A5480; }
      /* Lost or abandoned: still readable, visibly not live. */
      .td-ticket-dead { opacity: .62; }
      .td-combo-parts { display: block; color: #7A6A93; }
      .td-repair-icon { color: #4A5480; vertical-align: -2px; margin-right: 5px; }
      .td-repair-filter { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px;
        border: 1px solid #DCD5C9; background: #FDFCFA; color: #6B6459; border-radius: 7px;
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .td-repair-filter:hover { border-color: #C6BCA9; }
      .td-repair-filter.active { background: #E2E4EE; border-color: #B9BFD6; color: #4A5480; }
      .td-ticket-jobno { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #A39A88; margin-top: -4px; }
      .td-ghl-badge { font-size: 9.5px; font-weight: 700; letter-spacing: .04em; padding: 2px 6px;
        border-radius: 3px; background: #E2E4EE; color: #4A5480; white-space: nowrap; }
      .td-idline { display: flex; gap: 18px; flex-wrap: wrap; padding: 0 0 14px; font-size: 12px; color: var(--td-muted); }
      .td-idline-item { font-family: 'IBM Plex Mono', monospace; }
      .td-idline-item strong { font-family: inherit; font-weight: 600; color: var(--td-muted); text-transform: uppercase;
        letter-spacing: .03em; font-size: 10.5px; margin-right: 5px; }
      .td-ticket-substage { font-size: 10.5px; font-weight: 600; color: #8A8478; letter-spacing: .01em;
        text-transform: uppercase; margin-top: 6px; }
      /* Collected in full: the card stops asking for attention. */
      .td-ticket-paid { background: #F6FAF5; border-color: #CBDFC7; }
      /* On hold outranks paid — a stalled job should look stalled. */
      .td-ticket-flagmark { position: absolute; top: 7px; right: 7px;
        display: inline-flex; pointer-events: none; }
      .td-ticket-flagmark + .td-ticket-head { padding-right: 20px; }
      .td-flag-icon { vertical-align: -2px; margin-right: 5px; }
      .td-flag-select.active { background: #FDF3E3; border-color: #E6D3A6; }
      .td-substage-chip { font-size: 10.5px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .02em; color: #8A8478; background: #F0EBE1; border-radius: 4px; padding: 4px 8px; }
      .td-hold-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
        border: 1px solid #DCD5C9; background: #FDFCFA; color: #6B6459; border-radius: 7px;
        font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
      .td-hold-toggle:hover { border-color: #C6BCA9; }
      .td-hold-toggle.active { background: #FDF3E3; border-color: #E6D3A6; color: #8A5A12; }

      .td-deal-modal-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }

      /* ---------- Ageing: stalled jobs ---------- */
      /* Strong enough to find across a full column at a glance, light enough
         that the figures on the card stay readable. */
      .td-ticket-overdue { box-shadow: 0 0 0 1px #C25B47 inset, 0 1px 3px rgba(178,58,46,.18); }
      .td-ticket-flag-overdue { background: #F6CFC6; color: #8C2D1C; }
      .td-age-emoji { font-size: 12px; line-height: 1; filter: saturate(1.1); }
      .td-ticket-flagmark { gap: 3px; align-items: center; }
      .td-age-panel { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 18px;
        padding: 10px 13px; margin-top: 2px; border: 1px solid var(--td-border);
        border-radius: var(--td-radius); background: #FBF9F5; }
      .td-age-panel-hot { background: #FDEEEA; border-color: #E0B3A8; }
      .td-age-item { display: flex; flex-direction: column; gap: 2px; }
      .td-age-item strong { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700; }
      .td-age-gap { display: flex; align-items: center; gap: 7px; width: 100%;
        padding: 8px 10px; border-radius: 7px; background: #F3E7C9; color: #8A6A0B;
        font-size: 12.5px; font-weight: 600; }
      .td-age-gap svg { flex: none; }

      /* ---------- Reports: named reports (monthly scorecard) ---------- */
      .td-rpt-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
      .td-rpt-tab { border: 1px solid var(--td-border); background: var(--td-card); border-radius: 999px;
        padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; color: inherit; }
      .td-rpt-tab-on { background: #2B2A27; border-color: #2B2A27; color: #fff; }
      .td-sc .td-stat-row { margin-bottom: 14px; }
      .td-bal .td-stat-row { grid-template-columns: repeat(5, 1fr); }
      @media (max-width: 1100px) { .td-bal .td-stat-row { grid-template-columns: repeat(3, 1fr); } }
      @media (max-width: 900px) { .td-bal .td-stat-row { grid-template-columns: 1fr 1fr; } }
      .td-sc .td-report-controls { grid-template-columns: repeat(auto-fit, minmax(165px, 220px)); }
      .td-sc-chart { margin: 4px 0 14px; }
      .td-sc-svg { width: 100%; height: auto; display: block; }
      .td-sc-axis { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; fill: #8A8478; }
      .td-sc-legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--td-muted); margin-top: 4px; }
      .td-sc-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
      .td-sc-table td, .td-sc-table th { white-space: nowrap; }
      .td-sc-sub { display: inline-block; min-width: 18px; margin-left: 6px; font-size: 10.5px; color: #8A8478; }
      .td-sc-prov { color: #8A5A12; }
      .td-sc-key { font-size: 12px; color: var(--td-muted); margin: 10px 0 0; }
      .td-bal-jobs { margin-top: 14px; }
      .td-bal-row { cursor: pointer; }
      .td-bal-row:hover td { background: #FAF7F1; }
      .td-bal-job { font-family: 'IBM Plex Mono', monospace; font-size: 12px; white-space: nowrap; }
      .td-bal-sub { font-size: 11.5px; color: var(--td-muted); }
      .td-bal-jobs td { vertical-align: top; }
      .td-bal-jobs .td-num { white-space: nowrap; }
      .td-bal-src { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: .03em; background: #F6E7C8; color: #8A5A12; vertical-align: 1px; }
      .td-bal-flags { display: flex; flex-wrap: wrap; gap: 4px; max-width: 280px; }
      .td-bal-flag { font-size: 11px; padding: 1px 6px; border-radius: 3px; line-height: 1.5; }
      .td-bal-flag-red { background: #F8E1DC; color: #9A2E1C; }
      .td-bal-flag-amber { background: #F6E7C8; color: #7A4F0E; }
      .td-bal-flag-grey { background: #EFEBE3; color: #5E594F; }
      .td-sc-loading { padding: 24px 0; color: var(--td-muted); font-size: 13px; }
      .td-sc-coverage dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0; font-size: 13px; }
      .td-sc-coverage dt { font-weight: 650; }
      .td-sc-coverage dd { margin: 0; color: #4A463F; }
      .td-sc .td-sc-coverage { margin-top: 12px; }
      @media (max-width: 640px) {
        .td-sc-coverage dl { grid-template-columns: 1fr; gap: 2px; }
        .td-sc-coverage dd { margin-bottom: 8px; }
      }

      /* ---------- Reports: the transaction report builder ---------- */
      .td-report { margin-bottom: 16px; }
      .td-report .td-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .td-report-actions { display: flex; gap: 8px; }
      .td-report-controls { display: grid; gap: 10px 12px; align-items: end; margin: 12px 0 14px;
        grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); }
      .td-report-search { grid-column: span 2; }
      .td-report-reset { align-self: end; white-space: nowrap; }
      .td-report-totals { display: flex; align-items: baseline; gap: 22px; flex-wrap: wrap;
        padding: 11px 13px; margin-bottom: 12px; border: 1px solid var(--td-border);
        border-radius: var(--td-radius); background: #FBF9F5; }
      .td-report-totals > div { display: flex; flex-direction: column; gap: 2px; }
      .td-report-totals strong { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700; }
      .td-report-range { margin-left: auto; font-family: 'IBM Plex Mono', monospace;
        font-size: 11.5px; color: var(--td-muted); align-self: center; }
      .td-report-toggle { margin: 12px 0 4px; }
      .td-report-trunc { padding: 9px 12px; font-size: 12px; color: var(--td-muted);
        border-top: 1px solid var(--td-border); }
      .td-report .td-num { text-align: right; font-family: 'IBM Plex Mono', monospace; }
      .td-report tfoot td { border-top: 2px solid var(--td-border); background: #FBF9F5; }
      .td-paytype-chip { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em;
        color: #4A5480; background: #E2E4EE; border-radius: 3px; padding: 2px 6px; white-space: nowrap; }
      @media (max-width: 640px) {
        .td-report-search { grid-column: span 1; }
        .td-report-range { margin-left: 0; }
      }

      /* Job detail header. Chips on one line, editable fields on a grid that
         reflows instead of crushing its columns. */
      .td-deal-head { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
      .td-deal-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .td-deal-fields { display: grid; gap: 10px 12px; align-items: end;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
      .td-deal-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      /* Beat the .td-deal-modal-row/.td-filter-group width:auto rule and let the
         grid track decide the width, so nothing truncates mid-word. */
      .td-deal-field .td-select, .td-deal-field .td-input { width: 100%; min-width: 0; }
      .td-deal-field-amount .td-input { font-weight: 700; }
      .td-deal-field-name { grid-column: 1 / -1; }
      /* The contact line keeps its icons and its place; only the two values
         become boxes. Capped so a short phone number does not stretch to the
         width of the card. */
      .td-nav-badge { margin-left: auto; min-width: 19px; height: 19px; padding: 0 6px;
        border-radius: 999px; background: #C1440E; color: #fff; font-size: 11px; font-weight: 700;
        display: inline-flex; align-items: center; justify-content: center; }
      .td-gp-final { display: flex; align-items: center; flex-wrap: wrap; gap: 9px 12px;
        margin: 10px 0 2px; padding: 10px 13px; border: 1px solid #EBE6DC; border-radius: 9px;
        background: #FBFAF7; }
      .td-gp-final-main { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: 1; min-width: 0; }
      .td-gp-final > button { flex: none; }
      .td-gp-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
        border-radius: 999px; background: #E6EFE8; color: #2F6B46; font-size: 12px; font-weight: 650; }
      .td-gp-when { font-size: 12px; color: #6E675C; }
      .td-gp-drift-note { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
        border-radius: 999px; background: #FDF3E3; color: #8A5A12; font-size: 12px; font-weight: 600; }
      .td-gp-drift { font-size: 11.5px; color: #8A5A12; margin-top: 2px; }
      .td-gp-msg { flex-basis: 100%; font-size: 12px; color: #2F6B46; }
      .td-gp-msg-err { color: #9B3A20; }
      .td-contact-edit { flex-wrap: wrap; margin-bottom: 8px; }
      .td-contact-edit .td-input { flex: 1 1 150px; min-width: 0; max-width: 250px;
        padding: 5px 8px; font-size: 13px; }
      /* The same grid for a project manager, with the values set as text. Kept
         on the identical field frame so the card does not change shape. */
      .td-deal-ro-value { font-size: 13.5px; font-weight: 600; color: #3A352E;
        padding: 7px 0; min-height: 19px; display: flex; align-items: center; gap: 6px; }
      .td-deal-field-amount .td-deal-ro-value { font-weight: 700; }
      .td-hold-toggle { white-space: nowrap; }
      .td-substage-chip { white-space: nowrap; }

      /* ---------- Assignments on the job card ---------- */
      .td-assign { display: grid; gap: 12px 18px; margin: 12px 0 2px; padding: 11px 13px;
        border: 1px solid var(--td-border); border-radius: var(--td-radius); background: #FBF9F5;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); align-items: start; }
      .td-assign-role { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .td-assign-role-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .td-assign-note { font-size: 10.5px; color: var(--td-muted); font-style: italic; }
      .td-assign-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        background: var(--td-card); border: 1px solid var(--td-border); border-radius: 4px; padding: 5px 6px; }
      .td-assign-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
        border-radius: 3px; font-size: 12px; font-weight: 600; white-space: nowrap; }
      .td-assign-retired { opacity: .7; }
      .td-assign-dates { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px;
        border: 1px dashed var(--td-border); border-radius: 3px; background: transparent;
        font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--td-text); cursor: pointer; }
      .td-assign-dates:hover { border-style: solid; border-color: var(--td-accent); }
      .td-assign-dates-empty { color: var(--td-muted); font-family: 'Inter', sans-serif; font-style: italic; }
      .td-assign-date { width: 132px; min-width: 0; padding: 4px 6px; font-size: 12px; }
      .td-assign-dash { color: var(--td-muted); font-size: 12px; }
      .td-assign-add { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
      .td-assign-add .td-select, .td-assign-add .td-input { min-width: 0; }
      .td-assign-add > .td-select { flex: 1 1 150px; }
      .td-btn-ghost { background: transparent; border-color: transparent; color: var(--td-muted); }
      .td-btn-ghost:hover { color: var(--td-text); }

      /* ---------- Calendar ---------- */
      .td-cal-head { align-items: flex-start; gap: 12px; flex-wrap: wrap; }
      .td-cal-nav { display: flex; align-items: center; gap: 6px; }
      .td-cal-month { font-family: 'Oswald', sans-serif; font-size: 16px; font-weight: 600; margin-left: 6px; }
      .td-cal-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .td-cal-modes { display: flex; border: 1px solid var(--td-border); border-radius: var(--td-radius); overflow: hidden; }
      .td-cal-mode { display: flex; align-items: center; gap: 5px; padding: 6px 10px; border: none;
        background: var(--td-card); font-size: 12px; font-weight: 600; color: var(--td-muted); cursor: pointer; }
      .td-cal-mode.active { background: var(--td-ink); color: var(--td-ink-text); }

      .td-cal-weekdays { display: grid; grid-template-columns: repeat(7, 1fr);
        font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700;
        color: var(--td-muted); padding: 0 0 5px; }
      .td-cal-weekdays > div { padding-left: 6px; }
      .td-cal-week { border: 1px solid var(--td-border); border-radius: var(--td-radius);
        margin-bottom: 7px; overflow: hidden; background: var(--td-card); }
      .td-cal-days { display: grid; grid-template-columns: repeat(7, 1fr); }
      .td-cal-day { min-height: 22px; padding: 3px 6px; border-right: 1px solid var(--td-track); }
      .td-cal-day:last-child { border-right: none; }
      .td-cal-day-out { background: #F7F4EC; }
      .td-cal-daynum { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--td-muted); }
      .td-cal-day-out .td-cal-daynum { opacity: .55; }
      .td-cal-day-today { background: #FDF0E8; }
      .td-cal-day-today .td-cal-daynum { color: var(--td-accent); font-weight: 700; }
      /* Bars live on their own grid under the day numbers rather than inside a
         cell, which is what lets one run from Tuesday to Friday as a single
         block instead of four disconnected pills. */
      .td-cal-lanes { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
        padding: 2px 2px 5px; }
      .td-cal-bar { display: block; min-width: 0; overflow: hidden; text-align: left;
        border: none; border-radius: 3px; padding: 3px 6px; font: inherit; font-size: 11px;
        line-height: 1.25; cursor: pointer; }
      .td-cal-bar:hover { filter: brightness(1.08); }
      /* A run that carries on past the edge of the window is squared off there,
         so a four-day job does not read as ending on Sunday. */
      .td-cal-bar-l { border-top-left-radius: 0; border-bottom-left-radius: 0; }
      .td-cal-bar-r { border-top-right-radius: 0; border-bottom-right-radius: 0; }
      .td-cal-bar-text { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
      .td-cal-bar-text strong { font-weight: 700; white-space: nowrap; }
      .td-cal-bar-text span { opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .td-cal-people-scroll { overflow-x: auto; }
      .td-cal-people { --col: 30px; min-width: min-content; }
      .td-cal-people-row { display: grid; grid-template-columns: 148px calc(var(--days) * var(--col));
        border-bottom: 1px solid var(--td-track); }
      .td-cal-people-row:last-child { border-bottom: none; }
      .td-cal-people-head { border-bottom: 1px solid var(--td-border); }
      .td-cal-person-name { display: flex; align-items: center; gap: 7px; padding: 7px 10px 7px 2px;
        font-size: 12.5px; font-weight: 600; position: sticky; left: 0; background: var(--td-card); z-index: 1;
        border-right: 1px solid var(--td-track); }
      .td-cal-person-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .td-cal-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
      .td-cal-person-track { display: grid; grid-template-columns: repeat(var(--days), var(--col));
        gap: 2px; padding: 4px 0; align-content: start; }
      .td-cal-person-dates { gap: 0; padding: 0; }
      .td-cal-pday { display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 4px 0; border-right: 1px solid var(--td-track); font-size: 9px; color: var(--td-muted); }
      .td-cal-pday strong { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600; }
      .td-cal-pday-weekend { background: #F7F4EC; }

      .td-cal-pop { position: fixed; z-index: 120; width: 300px; display: flex; flex-direction: column; gap: 9px;
        background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius);
        padding: 12px; box-shadow: 0 10px 30px rgba(34,30,23,.18); }
      .td-cal-pop-head { display: flex; align-items: center; gap: 8px; }
      .td-cal-pop-dates { display: flex; align-items: center; gap: 6px;
        font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; font-weight: 600; }
      .td-cal-pop-job { display: flex; flex-direction: column; gap: 4px;
        border-top: 1px solid var(--td-track); padding-top: 9px; }
      .td-cal-pop-addr { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; font-weight: 600; line-height: 1.3; }
      .td-cal-pop-addr svg { flex: none; margin-top: 2px; }
      .td-cal-pop-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; }
      .td-cal-pop-amt { font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 700; }
      .td-cal-pop-others { display: flex; flex-direction: column; gap: 4px;
        border-top: 1px solid var(--td-track); padding-top: 9px; }
      .td-cal-pop-other { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .td-cal-pop-open { justify-content: center; }

      @media (max-width: 720px) {
        .td-cal-bar-text span { display: none; }
        .td-cal-person-name { width: 120px; }
        .td-cal-people-row { grid-template-columns: 120px calc(var(--days) * var(--col)); }
      }

      /* ---------- Job detail ---------- */
      .td-job-detail { display: flex; flex-direction: column; gap: 4px; }
      .td-linked-badge { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; font-size: 10.5px; font-weight: 700; color: #5B5BA0; background: #ECEBF7; border-radius: 3px; padding: 0 5px; vertical-align: 2px; }
      .td-linked { border: 1px solid var(--td-border); border-radius: var(--td-radius); padding: 10px 12px; margin: 12px 0 4px; background: var(--td-card); }
      .td-linked-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 13px; font-weight: 600; }
      .td-linked-total { font-weight: 500; color: var(--td-muted); font-size: 12px; }
      .td-linked-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .td-linked-list li { display: grid; grid-template-columns: 78px 1fr 90px 1fr auto auto auto; gap: 8px; align-items: center; font-size: 12.5px; }
      .td-linked-lost { font-size: 10.5px; text-transform: uppercase; font-weight: 700; color: #9A2E1C; background: #F8E1DC; border-radius: 3px; padding: 0 5px; }
      .td-linked-add { display: flex; gap: 6px; margin-top: 8px; }
      .td-linked-add .td-input { max-width: 200px; }
      .td-linked-err { color: #9A2E1C; font-size: 12px; margin-top: 6px; }
      @media (max-width: 640px) { .td-linked-list li { grid-template-columns: 70px 1fr auto auto; } }
      .td-payment-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius); padding: 12px 14px; margin: 12px 0 4px; }
      .td-payment-summary-item { display: flex; flex-direction: column; gap: 4px; }
      .td-payment-summary-value { font-family: 'Oswald', sans-serif; font-size: 17px; font-weight: 600; }
      .td-job-detail-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 10px; }
      .td-job-detail-col { display: flex; flex-direction: column; }
      .td-payment-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; max-height: 220px; overflow-y: auto; }
      .td-payment-row { display: flex; align-items: center; gap: 8px; background: var(--td-card); border: 1px solid var(--td-border); border-radius: 4px; padding: 8px 9px; }
      .td-payment-row-main { flex: 1; min-width: 0; }
      .td-payment-row-top { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
      .td-payment-amount { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 13px; }
      .td-payment-form { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--td-border); padding-top: 10px; }
      .td-payment-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .td-payment-btns { display: flex; flex-wrap: wrap; gap: 6px; }
      /* Client credits: plum, deliberately not red — a credit is not an error. */
      .td-credit-text { color: #6A4C93; font-weight: 600; }
      .td-credit-row { background: #F6F2FA; border-color: #DCD1EA; }
      .td-credit-chip { color: #6A4C93; background: #E9E1F3; }
      .td-btn.td-credit-btn { color: #6A4C93; border-color: #CDBFE0; }
      .td-btn.td-credit-btn-solid { background: #6A4C93; color: #fff; border-color: #6A4C93; }
      .td-btn.td-credit-btn-solid:disabled { opacity: .5; cursor: not-allowed; }
      .td-credit-form { margin-top: 10px; border-top-color: #CDBFE0; }
      .td-credit-form-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; color: #6A4C93; }

      /* ---------- Responsive ---------- */
      @media (max-width: 900px) {
        .td-stat-row { grid-template-columns: 1fr 1fr; }
        .td-dash-grid { grid-template-columns: 1fr; }
        .td-form-grid { grid-template-columns: 1fr; }
        .td-job-detail-cols { grid-template-columns: 1fr; }
        .td-payment-summary { grid-template-columns: 1fr 1fr; }
        .td-hamburger { display: block; }
        .td-topbar-title { display: none; }
        .td-sidebar { position: fixed; left: -240px; top: 0; bottom: 0; z-index: 90; transition: left 0.2s ease; }
        .td-sidebar-open .td-sidebar { left: 0; }
      }
      @media (max-width: 560px) {
        .td-stat-row { grid-template-columns: 1fr; }
        .td-content { padding: 14px; }
        .td-topbar { padding: 10px 12px; }
        .td-topbar-search { max-width: none; }
        .td-payment-summary { grid-template-columns: 1fr 1fr; }
      }
    `}</style>
  );
}
