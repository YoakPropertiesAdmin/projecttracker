/**
 * Deprecated — kept so older imports don't dangle.
 *
 * TradeDesk no longer persists a single JSON blob through a
 * `{ get(key), set(key, value) }` adapter. It now reads and writes four
 * related Postgres tables (jobs, vendors, client_payments, vendor_payments)
 * in Supabase, one row at a time.
 *
 * The persistence boundary is `repository.js`. Import from there.
 */
export { repo } from "./repository.js";
export { repo as dataAdapter } from "./repository.js";
