-- REV-001. Immutable issue-time schedules and monthly journal contributions.
-- Dates/cents are retained financial facts; basis JSON is withdrawn by GOV-005.
CREATE TABLE nc_revenue_schedules (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL UNIQUE REFERENCES nc_invoice_lines(id),
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  policy_version TEXT NOT NULL,
  policy TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
  service_start TEXT NOT NULL,
  service_end TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json))
);
CREATE INDEX nc_revenue_schedules_invoice ON nc_revenue_schedules(invoice_id);
CREATE TABLE nc_revenue_entries (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES nc_revenue_schedules(id),
  line_id TEXT NOT NULL REFERENCES nc_invoice_lines(id),
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  recognition_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  UNIQUE(schedule_id,recognition_date)
);
CREATE INDEX nc_revenue_entries_invoice ON nc_revenue_entries(invoice_id);
CREATE INDEX nc_revenue_entries_month ON nc_revenue_entries(recognition_date,customer_id);
CREATE TABLE nc_revenue_credits (
  id TEXT PRIMARY KEY,
  credit_id TEXT NOT NULL UNIQUE REFERENCES nc_credit_notes(id),
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  recognition_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents<0),
  policy_version TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json))
);
CREATE INDEX nc_revenue_credits_invoice ON nc_revenue_credits(invoice_id);
CREATE INDEX nc_revenue_credits_month ON nc_revenue_credits(recognition_date,customer_id);

CREATE TRIGGER nc_revenue_schedule_source BEFORE INSERT ON nc_revenue_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
  SELECT 1 FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
  WHERE l.id=NEW.line_id AND i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.status='issued' AND l.amount_cents=NEW.amount_cents
) BEGIN SELECT RAISE(ABORT,'nectar_guard_revenue_source_changed'); END;
CREATE TRIGGER nc_revenue_entry_source BEFORE INSERT ON nc_revenue_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
  SELECT 1 FROM nc_revenue_schedules s WHERE s.id=NEW.schedule_id AND s.line_id=NEW.line_id AND s.invoice_id=NEW.invoice_id AND s.customer_id=NEW.customer_id
) BEGIN SELECT RAISE(ABORT,'nectar_guard_revenue_source_changed'); END;
CREATE TRIGGER nc_revenue_credit_source BEFORE INSERT ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
  SELECT 1 FROM nc_credit_notes n WHERE n.id=NEW.credit_id AND n.invoice_id=NEW.invoice_id AND n.customer_id=NEW.customer_id AND -n.amount_cents=NEW.amount_cents
) BEGIN SELECT RAISE(ABORT,'nectar_guard_revenue_source_changed'); END;

-- Privacy exceptions only arise inside the checked owner-approved transaction.
CREATE TRIGGER nc_revenue_schedule_immutable BEFORE UPDATE ON nc_revenue_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_schedule_keep BEFORE DELETE ON nc_revenue_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_entry_immutable BEFORE UPDATE ON nc_revenue_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_entry_keep BEFORE DELETE ON nc_revenue_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_credit_immutable BEFORE UPDATE ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_credit_keep BEFORE DELETE ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TRIGGER nc_privacy_generation_nc_revenue_schedules_insert AFTER INSERT ON nc_revenue_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_schedules_update AFTER UPDATE ON nc_revenue_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_schedules_delete AFTER DELETE ON nc_revenue_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_entries_insert AFTER INSERT ON nc_revenue_entries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_entries_update AFTER UPDATE ON nc_revenue_entries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_entries_delete AFTER DELETE ON nc_revenue_entries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_insert AFTER INSERT ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_update AFTER UPDATE ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_delete AFTER DELETE ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- All relationships have actual FKs, including the owning customer, so the
-- current erasure inventory and eventual financial purge discover every row.
CREATE TRIGGER nc_privacy_owned_nc_revenue_schedules_insert BEFORE INSERT ON nc_revenue_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=NEW.invoice_id AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_revenue_schedules_update BEFORE UPDATE ON nc_revenue_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id IN (NEW.customer_id,OLD.customer_id) AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id IN (NEW.invoice_id,OLD.invoice_id) AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_revenue_entries_insert BEFORE INSERT ON nc_revenue_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=NEW.invoice_id AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_revenue_entries_update BEFORE UPDATE ON nc_revenue_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id IN (NEW.customer_id,OLD.customer_id) AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id IN (NEW.invoice_id,OLD.invoice_id) AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_revenue_credits_insert BEFORE INSERT ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=NEW.invoice_id AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_revenue_credits_update BEFORE UPDATE ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id IN (NEW.customer_id,OLD.customer_id) AND c.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id IN (NEW.invoice_id,OLD.invoice_id) AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
