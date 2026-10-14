-- Nectar: one business's B2B subscription billing records.
-- Money is stored in integer US cents after an explicit rounding step; unit
-- prices and quantities are exact decimal text (up to six fractional places).
-- Issued invoices, their lines, price versions, credit notes, payments and the
-- audit trail are append-only: corrections are new records, never edits.

CREATE TABLE nc_business (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  legal_name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  timezone TEXT NOT NULL,
  invoice_prefix TEXT NOT NULL,
  next_invoice_number INTEGER NOT NULL DEFAULT 1,
  next_credit_number INTEGER NOT NULL DEFAULT 1,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 120),
  tax_jurisdiction TEXT NOT NULL DEFAULT '',
  tax_mode TEXT NOT NULL DEFAULT 'undeclared' CHECK (tax_mode IN ('undeclared', 'no_tax', 'flat_rate')),
  tax_rate TEXT NOT NULL DEFAULT '0',
  tax_note TEXT NOT NULL DEFAULT '',
  tax_reviewed_by TEXT,
  tax_reviewed_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nc_members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'finance', 'accountant')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Application credentials for an owner's existing agent or metering pipeline.
-- Only the SHA-256 of the key is kept; the key is shown once.
CREATE TABLE nc_agent_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_by TEXT,
  revoked_at INTEGER
);

CREATE TABLE nc_customers (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK (tax_exempt IN (0, 1)),
  tax_exempt_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nc_contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'billing',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (customer_id, email)
);

CREATE TABLE nc_products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE nc_meters (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit_label TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Price versions never change once written; a new price is a new version.
CREATE TABLE nc_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES nc_products(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('flat', 'seat', 'unit')),
  unit_amount TEXT NOT NULL,
  meter_id TEXT REFERENCES nc_meters(id),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval = 'month'),
  taxable INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  nickname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  revision TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (product_id, version),
  CHECK ((kind = 'unit') = (meter_id IS NOT NULL))
);
CREATE TRIGGER nc_prices_immutable BEFORE UPDATE OF id, product_id, version, kind, unit_amount, meter_id, billing_interval, taxable, origin, created_by, created_at ON nc_prices BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- Entitlement grants: a product's price versions grant these features.
CREATE TABLE nc_features (
  product_id TEXT NOT NULL REFERENCES nc_products(id),
  feature TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product_id, feature)
);

CREATE TABLE nc_subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  external_id TEXT UNIQUE,
  anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 28),
  start_date TEXT NOT NULL,
  trial_end TEXT,
  end_date TEXT,
  billing_mode TEXT NOT NULL DEFAULT 'live' CHECK (billing_mode IN ('live', 'shadow')),
  cutover_start TEXT,
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  provider_schedule_ref TEXT,
  provider_collection TEXT,
  revision TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nc_items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  price_id TEXT NOT NULL REFERENCES nc_prices(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  change_id TEXT,
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX nc_items_subscription ON nc_items (subscription_id);

-- Contract exceptions. Only approved amendments affect a bill.
CREATE TABLE nc_amendments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  kind TEXT NOT NULL CHECK (kind IN ('discount_percent', 'fixed_credit', 'price_override')),
  value TEXT NOT NULL,
  price_id TEXT REFERENCES nc_prices(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  note TEXT NOT NULL DEFAULT '',
  clause TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import', 'proposal')),
  proposal_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  CHECK ((kind = 'price_override') = (price_id IS NOT NULL))
);
CREATE TRIGGER nc_amendments_decided BEFORE UPDATE ON nc_amendments WHEN OLD.status <> 'proposed' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- A scheduled plan or quantity change: prepared with its proration preview,
-- applied to the subscription only when approved against the same revision.
CREATE TABLE nc_changes (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  item_id TEXT NOT NULL REFERENCES nc_items(id),
  new_price_id TEXT NOT NULL REFERENCES nc_prices(id),
  new_quantity INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  subscription_revision TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'discarded')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);

CREATE TABLE nc_usage_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('file', 'api', 'correction')),
  filename TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  accepted INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Usage events: one row per stable event id. An event is billed at most once:
-- invoice_id is set when the invoice that rated it is issued.
CREATE TABLE nc_usage_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  meter_id TEXT NOT NULL REFERENCES nc_meters(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  quantity TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  occurred_text TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL REFERENCES nc_usage_batches(id),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  void_reason TEXT,
  invoice_id TEXT
);
CREATE INDEX nc_usage_lookup ON nc_usage_events (customer_id, meter_id, occurred_at);
CREATE TRIGGER nc_usage_immutable BEFORE UPDATE OF id, event_id, meter_id, customer_id, quantity, occurred_at, occurred_text, received_at, batch_id, payload_hash ON nc_usage_events BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_usage_billed_once BEFORE UPDATE OF invoice_id ON nc_usage_events WHEN OLD.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'nectar_guard_already_billed'); END;
CREATE TRIGGER nc_usage_void_unbilled BEFORE UPDATE OF status ON nc_usage_events WHEN OLD.invoice_id IS NOT NULL OR OLD.status <> 'active' BEGIN SELECT RAISE(ABORT, 'nectar_guard_already_billed'); END;
CREATE TRIGGER nc_usage_keep BEFORE DELETE ON nc_usage_events BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TABLE nc_bill_runs (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  calc_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalised', 'discarded')),
  summary_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finalised_by TEXT,
  finalised_at INTEGER
);
CREATE UNIQUE INDEX nc_bill_runs_one_draft ON nc_bill_runs (period) WHERE status = 'draft';

CREATE TABLE nc_invoices (
  id TEXT PRIMARY KEY,
  bill_run_id TEXT NOT NULL REFERENCES nc_bill_runs(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'shadow', 'approved', 'issued', 'discarded')),
  number TEXT UNIQUE,
  issue_date TEXT,
  due_date TEXT,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  calc_version TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  calculation_json TEXT NOT NULL,
  comparison_json TEXT NOT NULL,
  exceptions_json TEXT NOT NULL,
  approved_fingerprint TEXT,
  approved_by TEXT,
  approved_at INTEGER,
  issued_by TEXT,
  issued_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX nc_invoices_once ON nc_invoices (subscription_id, period_start) WHERE status = 'issued';
CREATE INDEX nc_invoices_run ON nc_invoices (bill_run_id);
CREATE INDEX nc_invoices_customer ON nc_invoices (customer_id);
CREATE TRIGGER nc_invoices_issued BEFORE UPDATE ON nc_invoices WHEN OLD.status = 'issued' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_invoices_keep BEFORE DELETE ON nc_invoices BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TABLE nc_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit_amount TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  taxable INTEGER NOT NULL,
  price_id TEXT,
  meter_id TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  UNIQUE (invoice_id, seq)
);
CREATE TRIGGER nc_lines_immutable BEFORE UPDATE ON nc_invoice_lines BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_lines_keep BEFORE DELETE ON nc_invoice_lines BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TABLE nc_credit_notes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  proposal_id TEXT,
  issued_by TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);
CREATE TRIGGER nc_credit_notes_immutable BEFORE UPDATE ON nc_credit_notes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_credit_notes_keep BEFORE DELETE ON nc_credit_notes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- Payments are evidence of money received outside Nectar; Nectar never collects.
CREATE TABLE nc_payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'check', 'card_external', 'other')),
  reference TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (customer_id, reference)
);
CREATE TRIGGER nc_payments_immutable BEFORE UPDATE ON nc_payments BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_payments_keep BEFORE DELETE ON nc_payments BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TABLE nc_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES nc_payments(id),
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  allocated_by TEXT NOT NULL,
  allocated_at INTEGER NOT NULL
);
CREATE TRIGGER nc_allocations_immutable BEFORE UPDATE ON nc_allocations BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_allocations_keep BEFORE DELETE ON nc_allocations BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- Reminder drafts. Phase one exports an approved draft; it never sends one.
CREATE TABLE nc_notices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  invoice_ids TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  basis TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'exported', 'discarded')),
  proposal_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  exported_at INTEGER
);

CREATE TABLE nc_tasks (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  invoice_id TEXT REFERENCES nc_invoices(id),
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_by TEXT,
  done_at INTEGER,
  outcome TEXT
);

-- Agent-prepared work. Approval re-checks every source version in `basis`.
CREATE TABLE nc_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('amendment', 'price_change', 'usage_correction', 'collection')),
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('member', 'agent')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  result_json TEXT
);
CREATE TRIGGER nc_proposals_decided BEFORE UPDATE ON nc_proposals WHEN OLD.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- The previous biller's invoices, kept read-only for shadow comparison.
CREATE TABLE nc_incumbent_invoices (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  total_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE TABLE nc_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TRIGGER nc_audit_no_update BEFORE UPDATE ON nc_audit BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_audit_no_delete BEFORE DELETE ON nc_audit BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- In-batch preconditions: a false guard aborts the whole batch with its code.
CREATE TABLE nc_guard (code TEXT NOT NULL, ok INTEGER NOT NULL);
CREATE TRIGGER nc_guard_stale BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code = 'stale' BEGIN SELECT RAISE(ABORT, 'nectar_guard_stale'); END;
CREATE TRIGGER nc_guard_source BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code = 'source_changed' BEGIN SELECT RAISE(ABORT, 'nectar_guard_source_changed'); END;
CREATE TRIGGER nc_guard_billed BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code = 'already_billed' BEGIN SELECT RAISE(ABORT, 'nectar_guard_already_billed'); END;
CREATE TRIGGER nc_guard_exceeds BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code = 'exceeds_balance' BEGIN SELECT RAISE(ABORT, 'nectar_guard_exceeds_balance'); END;
CREATE TRIGGER nc_guard_payment BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code = 'exceeds_payment' BEGIN SELECT RAISE(ABORT, 'nectar_guard_exceeds_payment'); END;
CREATE TRIGGER nc_guard_other BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code NOT IN ('stale', 'source_changed', 'already_billed', 'exceeds_balance', 'exceeds_payment') BEGIN SELECT RAISE(ABORT, 'nectar_guard_failed'); END;
