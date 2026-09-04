import React, { useState, useEffect, useMemo, useRef } from "react";
import { repo } from "./data/repository.js";
import { supabase, isSupabaseConfigured } from "./data/supabaseClient.js";
import {
  LayoutDashboard, LayoutGrid, List, Truck, TrendingUp,
  Home, Layers, AppWindow, DoorOpen,
  Plus, X, Search, Phone, Mail, MapPin, DollarSign, Check,
  ChevronDown, ChevronRight, Trash2, Pencil,
  AlertTriangle, Tag, Building2, Menu, ClipboardList, RefreshCw,
  Wallet, HandCoins, Percent, Calendar as CalendarIcon, LogOut
} from "lucide-react";

/* =========================================================================
   CONSTANTS & CONFIG
   ========================================================================= */

// Home-exterior trades only. If this company also does gutters, decking,
// painting, etc. just say so and this list grows — nothing else changes.
const TRADES = {
  roofing: { label: "Roofing", icon: Home, color: "#C1440E" },
  siding: { label: "Siding", icon: Layers, color: "#5B7B9A" },
  windows: { label: "Windows", icon: AppWindow, color: "#3F8EA6" },
  doors: { label: "Doors", icon: DoorOpen, color: "#8A6D3B" },
};
const TRADE_KEYS = Object.keys(TRADES);

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
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const fmtDateShort = (iso) => {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const timeAgo = (iso) => {
  if (!iso) return "\u2014";
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

/* ---------------- job financial derivations ---------------- */

const clientReceived = (job) => (job.clientPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
const clientBalance = (job) => Number(job.contractAmount || 0) - clientReceived(job);
const vendorPaid = (job) => (job.vendorPayments || []).filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.amount || 0), 0);
const vendorPending = (job) => (job.vendorPayments || []).filter((p) => p.status === "pending").reduce((s, p) => s + Number(p.amount || 0), 0);
const vendorTotal = (job) => vendorPaid(job) + vendorPending(job);
const jobMargin = (job) => Number(job.contractAmount || 0) - vendorTotal(job);
const jobMarginPct = (job) => (job.contractAmount ? jobMargin(job) / job.contractAmount : 0);
const paidPct = (job) => (job.contractAmount ? Math.min(1, clientReceived(job) / job.contractAmount) : 0);

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

  return { jobs, vendors, counters: { job: 1008 } };
}

/* =========================================================================
   DATA HOOK
   ========================================================================= */

function useJobTrackerData() {
  const [data, setDataState] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready
  const [loadError, setLoadError] = useState("");

  // One read of the four tables, assembled by the repository into the nested
  // shape the views already expect. Also used to re-sync after a failed write.
  const load = React.useCallback(async () => {
    try {
      const loaded = await repo.loadAll();
      if (loaded) {
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

  const vendorNames = useMemo(() => vendors.map((v) => v.name), [vendors]);

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
      clientPayments: [], vendorPayments: [], ...job,
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

  const signOut = () => { if (isSupabaseConfigured) supabase.auth.signOut(); };

  const ctx = {
    data: safeData, jobs, vendors, vendorNames, vendorSpend,
    addJob, updateJob, deleteJob,
    addClientPayment, deleteClientPayment,
    addVendorPayment, updateVendorPayment, deleteVendorPayment,
    addVendor, updateVendor, deleteVendor,
    selectedJobId, setSelectedJobId, showAddJob, setShowAddJob, showVendorForm, setShowVendorForm,
    search, setSearch,
  };

  const NAV = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "jobs", label: "Jobs", icon: LayoutGrid },
    { key: "vendors", label: "Vendors", icon: Truck },
    { key: "reports", label: "Reports", icon: TrendingUp },
  ];

  // All hooks above run unconditionally on every render; only the returned
  // JSX branches on load state, which keeps hook order stable (Rules of Hooks).
  if (status === "loading" || !data) {
    return (
      <div className="td-root td-loading-screen">
        <GlobalStyle />
        <RefreshCw size={22} className="td-spin" />
        <div>Loading TradeDesk\u2026</div>
      </div>
    );
  }

  return (
    <div className="td-root">
      <GlobalStyle />
      <style>{`
        .td-overage-hint{display:flex;align-items:center;gap:7px;margin:8px 0 2px;padding:7px 10px;
          border-radius:7px;background:#FDF3E3;color:#8A5A12;font-size:12px;line-height:1.35;}
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
                className={cls("td-nav-item", view === n.key && "active")}
                onClick={() => { setView(n.key); setSidebarOpen(false); }}>
                <n.icon size={16} strokeWidth={2.2} />
                <span>{n.label}</span>
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
              {TRADE_KEYS.map((k) => {
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
            <div className="td-topbar-title">{NAV.find((n) => n.key === view)?.label}</div>
            <div className="td-topbar-search">
              <Search size={14} />
              <input placeholder="Search jobs by customer, address, job #\u2026" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <button className="td-btn td-btn-primary" onClick={() => setShowAddJob(true)}>
              <Plus size={15} /> New job
            </button>
          </header>

          {(loadError || persistError) && (
            <div className="td-sync-banner">
              <AlertTriangle size={15} />
              <span>{loadError || persistError}</span>
              <button type="button" onClick={() => { setPersistError(""); reload(); }}>Retry</button>
            </div>
          )}

          <main className="td-content">
            {view === "dashboard" && <DashboardView ctx={ctx} setView={setView} />}
            {view === "jobs" && <JobsView ctx={ctx} />}
            {view === "vendors" && <VendorsView ctx={ctx} />}
            {view === "reports" && <ReportsView ctx={ctx} />}
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
    (j.clientPayments || []).forEach((p) => activity.push({ kind: "client", jobId: j.id, jobLabel: jobNo(j.number) + " \u00b7 " + j.customerName, amount: p.amount, date: p.date, note: p.note }));
    (j.vendorPayments || []).forEach((p) => activity.push({ kind: "vendor", jobId: j.id, jobLabel: jobNo(j.number) + " \u00b7 " + j.customerName, amount: p.amount, date: p.date, note: p.vendorName, status: p.status }));
  });
  activity.sort((a, b) => new Date(b.date) - new Date(a.date));
  const recentActivity = activity.slice(0, 6);

  return (
    <div className="td-view">
      <div className="td-stat-row">
        <TicketStat label="Active jobs" value={activeJobs.length} icon={LayoutGrid} accent="#3F8EA6" footnote={jobs.length + " total"} />
        <TicketStat label="Active contract value" value={money(activeContractValue)} icon={DollarSign} accent="#B8860B" />
        <TicketStat label="Client balance outstanding" value={money(arOutstanding)} icon={Wallet} accent="#C1440E" footnote="Owed to you" />
        <TicketStat label="Vendor balance outstanding" value={money(apOutstanding)} icon={HandCoins} accent="#B23A2E" footnote="You owe" />
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
                    <div className="td-list-row-sub">{jobNo(j.number)} \u00b7 target was {fmtDateShort(j.targetDate)}</div>
                  </div>
                  <StatusPill tone="red">{Math.abs(daysBetween(j.targetDate, new Date())) + "d late"}</StatusPill>
                </button>
              ))}
            </div>
          )}
        </div>

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
                    <div className="td-list-row-sub">{a.jobLabel}{a.kind === "client" && a.note ? " \u00b7 " + a.note : ""}</div>
                  </div>
                  <div className="td-list-row-end">{timeAgo(a.date)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
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
  const [dragOverStage, setDragOverStage] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  const matches = (j) => {
    if (tradeFilter !== "all" && j.trade !== tradeFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return j.customerName.toLowerCase().includes(q) || j.customerAddress.toLowerCase().includes(q) || jobNo(j.number).toLowerCase().includes(q);
  };

  const visible = jobs.filter(matches);

  const onDrop = (stageKey) => (e) => {
    e.preventDefault();
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
            {TRADE_KEYS.map((k) => <option key={k} value={k}>{TRADES[k].label}</option>)}
          </select>
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
                    {stageJobs.map((j) => (
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
              <thead><tr><th>Job</th><th>Customer</th><th>Trade</th><th>Stage</th><th>Contract</th><th>Balance due</th><th>Vendor owed</th><th>Target</th></tr></thead>
              <tbody>
                {[...visible].sort((a, b) => b.number - a.number).map((j) => {
                  const bal = clientBalance(j);
                  const owed = vendorPending(j);
                  return (
                    <tr key={j.id} className="td-table-row" onClick={() => setSelectedJobId(j.id)}>
                      <td className="td-mono">{jobNo(j.number)}</td>
                      <td>
                        <div className="td-cell-name">{j.customerName}</div>
                        <div className="td-cell-sub"><MapPin size={11} /> {j.customerAddress}</div>
                      </td>
                      <td><TradeBadge trade={j.trade} size="sm" /></td>
                      <td><StatusPill tone={j.stage === "closed" ? "green" : "neutral"}>{STAGES.find((s) => s.key === j.stage)?.label}</StatusPill></td>
                      <td>{money(j.contractAmount)}</td>
                      <td className={bal > 0 ? "td-text-red" : "td-text-green"}>{money(bal)}</td>
                      <td className={owed > 0 ? "td-text-red" : "td-cell-sub"}>{owed > 0 ? money(owed) : "\u2014"}</td>
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
  const bal = clientBalance(job);
  const owed = vendorPending(job);
  return (
    <div className={cls("td-ticket", dragging && "td-ticket-dragging")}
      style={{ "--tc": t ? t.color : "#8A8478" }}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={() => ctx.setSelectedJobId(job.id)}>
      <div className="td-ticket-head">
        <span className="td-ticket-no">{jobNo(job.number)}</span>
        <TradeBadge trade={job.trade} size="sm" />
      </div>
      <div className="td-ticket-title">{job.customerName}</div>
      <div className="td-ticket-contact">{job.customerAddress}</div>
      <div className="td-ticket-foot">
        <span className="td-ticket-value">{money(job.contractAmount)}</span>
        <span className="td-ticket-date">{fmtDateShort(job.targetDate)}</span>
      </div>
      {(bal > 0 || owed > 0) && (
        <div className="td-ticket-flags">
          {bal > 0 && <span className="td-ticket-flag td-ticket-flag-red"><Wallet size={10} /> {money(bal)} due</span>}
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
            {TRADE_KEYS.map((k) => <option key={k} value={k}>{TRADES[k].label}</option>)}
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

function JobDetailModal({ ctx, job, onClose }) {
  const { updateJob, deleteJob, addClientPayment, deleteClientPayment, addVendorPayment, updateVendorPayment, deleteVendorPayment, vendorNames } = ctx;
  const [notes, setNotes] = useState(job?.notes || "");
  const [cpForm, setCpForm] = useState({ amount: "", date: new Date().toISOString().slice(0, 10), method: PAYMENT_METHODS[0], note: "" });
  const [vpForm, setVpForm] = useState({ vendorName: "", category: VENDOR_CATEGORIES[0], amount: "", date: new Date().toISOString().slice(0, 10), status: "pending", note: "" });

  if (!job) return null;

  const received = clientReceived(job);
  const balance = clientBalance(job);
  const vPaid = vendorPaid(job);
  const vPending = vendorPending(job);
  const margin = jobMargin(job);
  const marginPercent = jobMarginPct(job);

  // Overpayment is allowed on purpose — a change order raises what the client
  // owes without the contract amount having been updated yet. So this warns
  // and lets you through rather than refusing the entry.
  const cpAmount = Number(cpForm.amount) || 0;
  const cpOverage = cpAmount - clientBalance(job);

  const submitClientPayment = () => {
    if (!cpForm.amount || cpAmount <= 0) return;
    if (cpOverage > 0 && !confirm(
      "This payment puts " + job.customerName + " " + money(cpOverage) +
      " over the " + money(job.contractAmount) + " contract.\n\n" +
      "That's normal after a change order — but if the contract amount should be higher, " +
      "update it first so the margin numbers stay right.\n\nLog the payment anyway?"
    )) return;
    addClientPayment(job.id, { amount: cpAmount, date: new Date(cpForm.date).toISOString(), method: cpForm.method, note: cpForm.note.trim() });
    setCpForm({ amount: "", date: new Date().toISOString().slice(0, 10), method: cpForm.method, note: "" });
  };

  const submitVendorPayment = () => {
    if (!vpForm.vendorName.trim() || !vpForm.amount || Number(vpForm.amount) <= 0) return;
    addVendorPayment(job.id, { vendorName: vpForm.vendorName.trim(), category: vpForm.category, amount: Number(vpForm.amount), date: new Date(vpForm.date).toISOString(), status: vpForm.status, note: vpForm.note.trim() });
    setVpForm({ vendorName: "", category: vpForm.category, amount: "", date: new Date().toISOString().slice(0, 10), status: "pending", note: "" });
  };

  return (
    <Modal title={jobNo(job.number) + " \u00b7 " + job.customerName} onClose={onClose} wide
      footer={<>
        <button className="td-btn td-btn-danger" onClick={() => { if (confirm("Delete this job? This can't be undone.")) deleteJob(job.id); }}><Trash2 size={13} /> Delete job</button>
        <div style={{ flex: 1 }} />
        <button className="td-btn td-btn-primary" onClick={() => { updateJob(job.id, { notes }); onClose(); }}>Save & close</button>
      </>}>
      <div className="td-job-detail">

        <div className="td-deal-modal-row">
          <TradeBadge trade={job.trade} />
          <select className="td-select" value={job.stage} onChange={(e) => updateJob(job.id, { stage: e.target.value })}>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="td-field-label" style={{ marginBottom: 3 }}>Contract amount</div>
            <input className="td-input td-input-num" style={{ width: 130, fontWeight: 700 }} type="number"
              value={job.contractAmount} onChange={(e) => updateJob(job.id, { contractAmount: Number(e.target.value) })} />
          </div>
        </div>

        <div className="td-info-row"><Building2 size={14} /> {job.customerAddress}</div>
        <div className="td-info-row"><Phone size={14} /> {job.customerPhone || "\u2014"}<Mail size={14} style={{ marginLeft: 14 }} /> {job.customerEmail || "\u2014"}</div>

        <div className="td-payment-summary">
          <div className="td-payment-summary-item">
            <span className="td-field-label">Received</span>
            <span className="td-payment-summary-value td-text-green">{money(received)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Balance due</span>
            <span className={cls("td-payment-summary-value", balance > 0 && "td-text-red")}>{money(balance)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Vendor costs owed</span>
            <span className={cls("td-payment-summary-value", vPending > 0 && "td-text-red")}>{money(vPending)}</span>
          </div>
          <div className="td-payment-summary-item">
            <span className="td-field-label">Margin</span>
            <span className={cls("td-payment-summary-value", margin < 0 && "td-text-red")}>{money(margin)} <span className="td-cell-sub">({pct(marginPercent)})</span></span>
          </div>
        </div>
        <ProgressBar value={paidPct(job)} tone={balance <= 0 ? "green" : undefined} />

        <div className="td-job-detail-cols">
          <div className="td-job-detail-col">
            <div className="td-drawer-section-title" style={{ borderTop: "none", paddingTop: 0 }}>Client payments</div>
            {(job.clientPayments || []).length === 0 ? <div className="td-muted-line">No payments logged yet.</div> : (
              <div className="td-payment-list">
                {[...job.clientPayments].sort((a, b) => new Date(b.date) - new Date(a.date)).map((p) => (
                  <div key={p.id} className="td-payment-row">
                    <div className="td-payment-row-main">
                      <div className="td-payment-row-top"><span className="td-payment-amount td-text-green">{moneyDec(p.amount)}</span><span className="td-cell-sub">{p.method}</span></div>
                      <div className="td-cell-sub">{fmtDate(p.date)}{p.note ? " \u00b7 " + p.note : ""}</div>
                    </div>
                    <button className="td-iconbtn td-iconbtn-danger" onClick={() => { if (confirm("Delete this " + money(p.amount) + " client payment? The balance due will go back up.")) deleteClientPayment(job.id, p.id); }} aria-label="Delete payment"><Trash2 size={12} /></button>
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
                <select className="td-select" value={cpForm.method} onChange={(e) => setCpForm((f) => ({ ...f, method: e.target.value }))}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input className="td-input" placeholder="Note (optional)" value={cpForm.note} onChange={(e) => setCpForm((f) => ({ ...f, note: e.target.value }))} />
              </div>
              {cpOverage > 0 && (
                <div className="td-overage-hint">
                  <AlertTriangle size={13} />
                  <span>{money(cpOverage)} over the {money(job.contractAmount)} contract — the job would show a {money(cpOverage)} credit.</span>
                </div>
              )}
              <button className="td-btn td-btn-primary td-btn-sm" onClick={submitClientPayment}><Plus size={13} /> Log client payment</button>
            </div>
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
                      <div className="td-cell-sub">{p.category} \u00b7 {fmtDate(p.date)}{p.note ? " \u00b7 " + p.note : ""}</div>
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
              <button className="td-btn td-btn-primary td-btn-sm" onClick={submitVendorPayment}><Plus size={13} /> Log vendor cost</button>
            </div>
          </div>
        </div>

        <Field label="Job notes">
          <textarea className="td-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Site access notes, material changes, punch list items\u2026" />
        </Field>
      </div>
    </Modal>
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
            <thead><tr><th>Vendor</th><th>Category</th><th>Contact</th><th>Jobs</th><th>Total paid</th><th>Still owed</th><th></th></tr></thead>
            <tbody>
              {filtered.map((v) => {
                const spend = vendorSpend[v.name] || { paid: 0, pending: 0, jobCount: 0 };
                return (
                  <tr key={v.id} className="td-table-row" onClick={() => setShowVendorForm(v)}>
                    <td className="td-cell-name">{v.name}</td>
                    <td className="td-cell-sub">{v.category}</td>
                    <td className="td-cell-sub">{v.phone || "\u2014"}</td>
                    <td>{spend.jobCount}</td>
                    <td>{money(spend.paid)}</td>
                    <td className={spend.pending > 0 ? "td-text-red" : "td-cell-sub"}>{spend.pending > 0 ? money(spend.pending) : "\u2014"}</td>
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
          <Field label="Notes"><textarea className="td-textarea" rows={2} value={form.notes} onChange={set("notes")} placeholder="Lead times, account number, terms\u2026" /></Field>
        </div>
      </div>
    </Modal>
  );
}

/* =========================================================================
   REPORTS
   ========================================================================= */

function ReportsView({ ctx }) {
  const { jobs, vendors } = ctx;

  const activeJobs = jobs.filter((j) => j.stage !== "closed");
  const totalContractValue = activeJobs.reduce((s, j) => s + Number(j.contractAmount || 0), 0);
  const totalAR = jobs.reduce((s, j) => s + Math.max(0, clientBalance(j)), 0);
  const totalAP = jobs.reduce((s, j) => s + vendorPending(j), 0);
  const totalMargin = jobs.reduce((s, j) => s + jobMargin(j), 0);

  const contractByTrade = TRADE_KEYS.map((k) => ({
    label: TRADES[k].label,
    value: jobs.filter((j) => j.trade === k).reduce((s, j) => s + Number(j.contractAmount || 0), 0),
    color: TRADES[k].color,
  })).filter((d) => d.value > 0);

  const jobsByStage = STAGES.map((s) => ({ label: s.label, value: jobs.filter((j) => j.stage === s.key).length, color: "#3F8EA6" }));

  const marginByTrade = TRADE_KEYS.map((k) => {
    const tradeJobs = jobs.filter((j) => j.trade === k);
    const rev = tradeJobs.reduce((s, j) => s + Number(j.contractAmount || 0), 0);
    const marg = tradeJobs.reduce((s, j) => s + jobMargin(j), 0);
    return { label: TRADES[k].label, value: rev ? Math.round((marg / rev) * 100) : 0, color: TRADES[k].color };
  }).filter((d) => jobs.some((j) => j.trade === TRADE_KEYS.find((k) => TRADES[k].label === d.label)));

  const arAging = jobs.filter((j) => clientBalance(j) > 0)
    .map((j) => ({ j, balance: clientBalance(j), days: daysBetween(j.startDate, new Date()) }))
    .sort((a, b) => b.balance - a.balance);

  const apAging = [];
  jobs.forEach((j) => (j.vendorPayments || []).filter((p) => p.status === "pending").forEach((p) => apAging.push({ job: j, payment: p })));
  apAging.sort((a, b) => new Date(a.payment.date) - new Date(b.payment.date));

  return (
    <div className="td-view">
      <div className="td-stat-row">
        <TicketStat label="Active contract value" value={money(totalContractValue)} icon={DollarSign} accent="#B8860B" />
        <TicketStat label="Client balance outstanding" value={money(totalAR)} icon={Wallet} accent="#C1440E" />
        <TicketStat label="Vendor balance outstanding" value={money(totalAP)} icon={HandCoins} accent="#B23A2E" />
        <TicketStat label="Total margin across jobs" value={money(totalMargin)} icon={Percent} accent="#3F7D58" />
      </div>

      <div className="td-dash-grid">
        <div className="td-panel">
          <div className="td-panel-head"><span>Contract value by trade</span></div>
          {contractByTrade.length === 0 ? <EmptyState icon={DollarSign} title="No jobs yet" /> : <BarChart data={contractByTrade} formatValue={money} />}
        </div>
        <div className="td-panel">
          <div className="td-panel-head"><span>Jobs by stage</span></div>
          <BarChart data={jobsByStage} formatValue={(v) => v} />
        </div>
        <div className="td-panel">
          <div className="td-panel-head"><span>Margin % by trade</span></div>
          {marginByTrade.length === 0 ? <EmptyState icon={Percent} title="No jobs yet" /> : <BarChart data={marginByTrade} formatValue={(v) => v + "%"} />}
        </div>
        <div className="td-panel">
          <div className="td-panel-head"><span>Vendor directory size</span></div>
          <DonutChart data={[{ label: "Vendors", value: vendors.length, color: "#3F8EA6" }]} />
        </div>

        <div className="td-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="td-panel-head"><span>Client balances outstanding (AR)</span></div>
          {arAging.length === 0 ? <EmptyState icon={Wallet} title="Nothing outstanding" sub="Every client is paid up." /> : (
            <div className="td-source-list">
              {arAging.map(({ j, balance, days }) => (
                <div key={j.id} className="td-source-row">
                  <span className="td-source-label">{j.customerName} \u00b7 {jobNo(j.number)}</span>
                  <span className="td-source-count">{days}d since start</span>
                  <span className="td-source-won td-text-red">{money(balance)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="td-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="td-panel-head"><span>Vendor balances owed (AP)</span></div>
          {apAging.length === 0 ? <EmptyState icon={HandCoins} title="Nothing owed" sub="Every vendor is paid up." /> : (
            <div className="td-source-list">
              {apAging.map(({ job, payment }) => (
                <div key={payment.id} className="td-source-row">
                  <span className="td-source-label">{payment.vendorName} \u00b7 {jobNo(job.number)}</span>
                  <span className="td-source-count">{payment.category}</span>
                  <span className="td-source-won td-text-red">{money(payment.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   GLOBAL STYLE
   ========================================================================= */

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
      .td-shell { display: flex; height: 100vh; min-height: 560px; }
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
      .td-content { flex: 1; overflow-y: auto; padding: 22px; }
      .td-view { display: flex; flex-direction: column; gap: 18px; }
      .td-view-flush { gap: 14px; }

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
      .td-table-wrap { background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius); overflow: hidden; overflow-x: auto; }
      .td-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .td-table thead th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--td-muted); padding: 10px 14px; background: var(--td-paper); border-bottom: 1px solid var(--td-border); white-space: nowrap; }
      .td-table td { padding: 11px 14px; border-bottom: 1px solid var(--td-border); vertical-align: middle; }
      .td-table-row { cursor: pointer; }
      .td-table-row:hover { background: #FBF8F1; }
      .td-table tbody tr:last-child td { border-bottom: none; }
      .td-cell-name { font-weight: 600; }
      .td-cell-sub { color: var(--td-muted); font-size: 12px; display: flex; align-items: center; gap: 3px; }
      .td-mono { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }

      .td-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 50px 20px; color: var(--td-muted); text-align: center; background: var(--td-card); border: 1px dashed var(--td-border); border-radius: var(--td-radius); }
      .td-empty-title { font-weight: 600; font-size: 13.5px; color: var(--td-text); }
      .td-empty-sub { font-size: 12px; max-width: 280px; }

      /* ---------- Kanban / tickets ---------- */
      .td-segment { display: inline-flex; border: 1px solid var(--td-border); border-radius: 4px; overflow: hidden; }
      .td-segment-btn { padding: 7px 13px; background: var(--td-card); border: none; border-right: 1px solid var(--td-border); font-size: 12.5px; font-weight: 500; cursor: pointer; color: var(--td-muted); }
      .td-segment-btn:last-child { border-right: none; }
      .td-segment-btn.active { background: var(--td-ink); color: #fff; }

      .td-kanban { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; align-items: flex-start; }
      .td-kanban-col { flex: none; width: 230px; background: #EAE4D4; border: 1px solid var(--td-border); border-radius: var(--td-radius); padding: 10px; min-height: 120px; }
      .td-kanban-col-over { outline: 2px dashed var(--td-accent); outline-offset: -2px; }
      .td-kanban-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; color: var(--td-muted); padding: 2px 2px 0; }
      .td-kanban-count { background: rgba(0,0,0,0.08); border-radius: 10px; padding: 1px 7px; font-size: 10.5px; }
      .td-kanban-col-total { font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600; padding: 4px 2px 10px; color: var(--td-text); }
      .td-kanban-col-body { display: flex; flex-direction: column; gap: 8px; min-height: 40px; }

      .td-ticket { background: var(--td-card); border: 1px solid var(--td-border); border-left: 3px solid var(--tc); border-radius: 4px; padding: 10px 11px; cursor: grab; box-shadow: 0 1px 2px rgba(20,16,8,0.06); }
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

      .td-deal-modal-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }

      /* ---------- Job detail ---------- */
      .td-job-detail { display: flex; flex-direction: column; gap: 4px; }
      .td-payment-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: var(--td-card); border: 1px solid var(--td-border); border-radius: var(--td-radius); padding: 12px 14px; margin: 12px 0 4px; }
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
