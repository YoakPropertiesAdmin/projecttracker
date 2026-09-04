# TradeDesk — Job & Payment Tracker

A focused project tracker for a home exterior company (roofing, siding,
windows, doors). It's meant to become the office-side companion to
**JobGuzzler**: JobGuzzler's mobile app handles the field/crew side, this
handles tracking a job from signed contract to closed — where it stands,
what the client has paid, and what's owed to vendors.

This is a deliberate pivot away from a full sales-CRM shape (no more
leads/pipeline/estimates/automations) toward one thing done well: **a job
record, its stage, and its two money ledgers.**

## Running it locally

```bash
npm install
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build      # production build, output in dist/
npm run preview    # serve that production build locally
```

## What's in it

- **Jobs board** — every job as a ticket, dragged across 8 stages from
  Contract Signed through Closed / Paid. List view alternative with
  balance-due and vendor-owed columns for quick scanning.
- **Job detail** — customer info, stage, contract amount, and two payment
  ledgers side by side:
  - **Client payments** — deposits/draws/final payment against the
    contract amount, with a running balance due.
  - **Vendor payments** — materials, subcontractor labor, permits,
    equipment, each logged as paid or pending, so you always know what
    you still owe.
  - A profitability strip (revenue, vendor cost, margin $/%) derived
    automatically from both ledgers.
- **Vendors** — a lightweight directory (name, category, contact info)
  with a rollup of total paid/pending across every job they've touched.
- **Reports** — active contract value and AR/AP totals, jobs by stage,
  contract value by trade, margin % by trade, and full AR/AP aging lists.

Trades are currently Roofing, Siding, Windows, Doors — the `TRADES` object
near the top of `src/App.jsx` is the only place that needs to change to
add more (gutters, decking, painting, etc.).

## Current state

Backed by **Supabase** (Postgres + Auth), deployed on **Netlify**.

Data lives in four related tables rather than one JSON blob, so two people in
the office can work at the same time without overwriting each other:

| Table | Holds |
|---|---|
| `jobs` | one row per job; `number` is assigned by a Postgres sequence |
| `vendors` | the vendor directory (unique by name) |
| `client_payments` | deposits/draws/final payments, FK to `jobs` (cascade delete) |
| `vendor_payments` | materials/labor/permits, FK to `jobs`, nullable FK to `vendors`, plus a `vendor_name` snapshot so a renamed or deleted vendor never rewrites payment history |

Row Level Security is on for all four. The policies admit only the
`authenticated` role, so the publishable key shipped in the browser bundle
reads nothing on its own — **an account is the access grant.** Sign-up is
closed; accounts are issued from the Supabase dashboard
(Authentication -> Users -> Invite).

### Environment

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key>
```

Both are public by design; see `.env.example`. Locally, copy it to
`.env.local`. On Netlify they live under Site configuration -> Environment
variables. With neither set, the app falls back to browser localStorage so
`npm run dev` still runs without credentials.

### How writes work

`src/data/repository.js` is the only module that knows both the nested shape
the UI uses and the relational shape Postgres stores. A mutation updates React
state immediately, then writes the single affected row. A failed write raises a
banner and re-reads from the database, so the screen never shows an unsaved
change as though it were saved.

### Tying this into JobGuzzler

Still open. The seam is the same one that made this migration a contained
change: everything goes through `repository.js`. Pointing job/customer records
at a JobGuzzler source of truth means reworking that one module, not the app.

## Project structure

```
tradedesk-crm/
├── index.html
├── package.json
├── vite.config.js
├── .env.example
├── src/
│   ├── main.jsx              # mounts App behind AuthGate
│   ├── App.jsx               # jobs, vendors, views, styling — all of it
│   ├── auth/
│   │   └── AuthGate.jsx      # sign-in screen + session handling
│   └── data/
│       ├── supabaseClient.js # client construction from env vars
│       ├── repository.js     # <- the persistence boundary
│       ├── localAdapter.js   # dev-only localStorage fallback
│       └── client.js         # deprecated shim, re-exports repository
```

Still one file in `App.jsx` on purpose, for the same reason as before:
easiest to keep pasting back into chat while we're iterating this way.
