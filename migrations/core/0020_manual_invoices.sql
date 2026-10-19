-- Preserve every issued row and foreign key while permitting non-subscription invoices.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE nc_invoices_next (
  id TEXT PRIMARY KEY,
  bill_run_id TEXT NOT NULL REFERENCES nc_bill_runs(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  subscription_id TEXT REFERENCES nc_subscriptions(id),
  invoice_kind TEXT NOT NULL DEFAULT 'recurring' CHECK(invoice_kind IN ('recurring','manual')),
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
INSERT INTO nc_invoices_next (id,bill_run_id,customer_id,subscription_id,period_start,period_end,status,number,issue_date,due_date,subtotal_cents,tax_cents,total_cents,currency,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,approved_fingerprint,approved_by,approved_at,issued_by,issued_at,created_at) SELECT id,bill_run_id,customer_id,subscription_id,period_start,period_end,status,number,issue_date,due_date,subtotal_cents,tax_cents,total_cents,currency,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,approved_fingerprint,approved_by,approved_at,issued_by,issued_at,created_at FROM nc_invoices;
DROP TABLE nc_invoices;
ALTER TABLE nc_invoices_next RENAME TO nc_invoices;
CREATE UNIQUE INDEX nc_invoices_once ON nc_invoices (subscription_id, period_start) WHERE status = 'issued' AND invoice_kind = 'recurring';
CREATE INDEX nc_invoices_run ON nc_invoices (bill_run_id);
CREATE INDEX nc_invoices_customer ON nc_invoices (customer_id);
CREATE TRIGGER nc_invoices_issued BEFORE UPDATE ON nc_invoices WHEN OLD.status = 'issued' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_invoices_keep BEFORE DELETE ON nc_invoices BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

ALTER TABLE nc_bill_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'recurring' CHECK(kind IN ('recurring','manual'));
DROP INDEX nc_bill_runs_one_draft;
CREATE UNIQUE INDEX nc_bill_runs_one_draft ON nc_bill_runs(period) WHERE status='draft' AND kind='recurring';
CREATE TABLE nc_charges (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 subscription_id TEXT REFERENCES nc_subscriptions(id), price_id TEXT REFERENCES nc_prices(id),
 description TEXT NOT NULL, quantity TEXT NOT NULL, unit_amount TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 taxable INTEGER NOT NULL, pricing_evidence_json TEXT NOT NULL, effective_date TEXT NOT NULL, invoice_id TEXT REFERENCES nc_invoices(id),
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER nc_charge_content BEFORE UPDATE OF customer_id,subscription_id,price_id,description,quantity,unit_amount,amount_cents,taxable,effective_date,pricing_evidence_json,created_by,created_at ON nc_charges BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_charge_consumed BEFORE UPDATE ON nc_charges WHEN OLD.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_charge_keep BEFORE DELETE ON nc_charges BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

-- Reconcile SQLite's deferred drop/recreate counters after checking the actual graph.
INSERT INTO nc_guard (code,ok) SELECT 'invoice_migration_foreign_keys', CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DELETE FROM nc_guard;
PRAGMA defer_foreign_keys = OFF;
