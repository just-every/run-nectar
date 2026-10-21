-- Historical corrections append effective bases; issued invoices/events stay immutable.
CREATE TABLE nc_usage_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), disposition TEXT NOT NULL CHECK(disposition IN ('next_invoice','correcting_invoice','credit_note')), revision INTEGER NOT NULL);
INSERT INTO nc_usage_policy VALUES(1,'next_invoice',0);
CREATE TABLE nc_usage_corrections (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 payload_json TEXT NOT NULL, plan_json TEXT NOT NULL, basis TEXT NOT NULL,
 prepared_by_id TEXT NOT NULL, prepared_by_kind TEXT NOT NULL CHECK(prepared_by_kind IN ('member','agent')), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 authorized_by_id TEXT, authorized_basis TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 decided_by TEXT, decided_at INTEGER
);
CREATE UNIQUE INDEX nc_usage_correction_pending ON nc_usage_corrections(subscription_id) WHERE status='pending';
CREATE TABLE nc_usage_replays (
 id INTEGER PRIMARY KEY AUTOINCREMENT, correction_id TEXT NOT NULL REFERENCES nc_usage_corrections(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 input_json TEXT NOT NULL, lines_json TEXT NOT NULL,
 UNIQUE(correction_id,invoice_id)
);
CREATE TABLE nc_usage_voids (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, correction_id TEXT NOT NULL REFERENCES nc_usage_corrections(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id));
CREATE TABLE nc_usage_adjustments (
 id TEXT PRIMARY KEY, correction_id TEXT NOT NULL REFERENCES nc_usage_corrections(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 original_invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), line_json TEXT NOT NULL, tax_cents INTEGER NOT NULL,
 invoice_id TEXT REFERENCES nc_invoices(id)
);
ALTER TABLE nc_credit_notes ADD COLUMN applied_cents INTEGER CHECK(applied_cents>=0 AND applied_cents<=amount_cents);
ALTER TABLE nc_credit_notes ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE nc_credit_notes ADD COLUMN tax_cents INTEGER;
ALTER TABLE nc_credit_notes ADD COLUMN correction_id TEXT REFERENCES nc_usage_corrections(id);
CREATE TABLE nc_usage_credit_applications (
 id TEXT PRIMARY KEY, credit_id TEXT NOT NULL REFERENCES nc_credit_notes(id), invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0), applied_at INTEGER NOT NULL,
 UNIQUE(credit_id,invoice_id)
);
CREATE TABLE nc_usage_correction_mail (
 correction_id TEXT PRIMARY KEY REFERENCES nc_usage_corrections(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','failed','uncertain','suppressed')),
 provider_ref TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE nc_policy_changes_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','certificate','tax','lifecycle','feature','usage')),
 payload_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')) DEFAULT 'pending',
 decided_by_id TEXT REFERENCES nc_members(id), decided_by TEXT, decided_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
INSERT INTO nc_policy_changes_next SELECT * FROM nc_policy_changes;
DROP TABLE nc_policy_changes;
ALTER TABLE nc_policy_changes_next RENAME TO nc_policy_changes;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TRIGGER nc_usage_corrections_keep BEFORE DELETE ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_corrections_content BEFORE UPDATE OF subscription_id,customer_id,payload_json,plan_json,basis,prepared_by_id,prepared_by_kind,prepared_by,prepared_at ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_corrections_immutable BEFORE UPDATE ON nc_usage_corrections WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_corrections_erased BEFORE INSERT ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_replays_keep BEFORE DELETE ON nc_usage_replays WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_replays_immutable BEFORE UPDATE ON nc_usage_replays WHEN (1) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_replays_erased BEFORE INSERT ON nc_usage_replays WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_voids_keep BEFORE DELETE ON nc_usage_voids WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_voids_immutable BEFORE UPDATE ON nc_usage_voids WHEN (1) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_voids_erased BEFORE INSERT ON nc_usage_voids WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_adjustments_keep BEFORE DELETE ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_adjustments_content BEFORE UPDATE OF correction_id,customer_id,subscription_id,original_invoice_id,line_json,tax_cents ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_adjustments_immutable BEFORE UPDATE ON nc_usage_adjustments WHEN (OLD.invoice_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_adjustments_erased BEFORE INSERT ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_credit_applications_keep BEFORE DELETE ON nc_usage_credit_applications WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_credit_applications_immutable BEFORE UPDATE ON nc_usage_credit_applications WHEN (1) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_credit_applications_erased BEFORE INSERT ON nc_usage_credit_applications WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_correction_mail_keep BEFORE DELETE ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_correction_mail_content BEFORE UPDATE OF correction_id,customer_id,recipient,subject,body ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_correction_mail_immutable BEFORE UPDATE ON nc_usage_correction_mail WHEN (OLD.status NOT IN ('pending','sending')) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_correction_mail_erased BEFORE INSERT ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_usage_corrections_generation_insert AFTER INSERT ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_corrections_generation_update AFTER UPDATE ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_corrections_generation_delete AFTER DELETE ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_replays_generation_insert AFTER INSERT ON nc_usage_replays WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_replays_generation_update AFTER UPDATE ON nc_usage_replays WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_replays_generation_delete AFTER DELETE ON nc_usage_replays WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_voids_generation_insert AFTER INSERT ON nc_usage_voids WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_voids_generation_update AFTER UPDATE ON nc_usage_voids WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_voids_generation_delete AFTER DELETE ON nc_usage_voids WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_adjustments_generation_insert AFTER INSERT ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_adjustments_generation_update AFTER UPDATE ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_adjustments_generation_delete AFTER DELETE ON nc_usage_adjustments WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_credit_applications_generation_insert AFTER INSERT ON nc_usage_credit_applications WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_credit_applications_generation_update AFTER UPDATE ON nc_usage_credit_applications WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_credit_applications_generation_delete AFTER DELETE ON nc_usage_credit_applications WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_correction_mail_generation_insert AFTER INSERT ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_correction_mail_generation_update AFTER UPDATE ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_correction_mail_generation_delete AFTER DELETE ON nc_usage_correction_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Preserve erasure authorization and restore-generation fences when extending policy kinds.
DROP TRIGGER nc_policy_change_content;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_decided;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_keep;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_insert AFTER INSERT ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_update AFTER UPDATE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_delete AFTER DELETE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Tax-attributed historical notes book pretax revenue, not tax as revenue.
CREATE TABLE nc_revenue_credits_next (
  id TEXT PRIMARY KEY,
  credit_id TEXT NOT NULL UNIQUE REFERENCES nc_credit_notes(id),
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  recognition_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
  policy_version TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json))
);
INSERT INTO nc_revenue_credits_next SELECT * FROM nc_revenue_credits;
DROP TABLE nc_revenue_credits;
ALTER TABLE nc_revenue_credits_next RENAME TO nc_revenue_credits;
CREATE INDEX nc_revenue_credits_invoice ON nc_revenue_credits(invoice_id);
CREATE INDEX nc_revenue_credits_month ON nc_revenue_credits(recognition_date,customer_id);
CREATE TRIGGER nc_revenue_credit_source BEFORE INSERT ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
  SELECT 1 FROM nc_credit_notes n WHERE n.id=NEW.credit_id AND n.invoice_id=NEW.invoice_id AND n.customer_id=NEW.customer_id AND -COALESCE(n.subtotal_cents,n.amount_cents)=NEW.amount_cents
) BEGIN SELECT RAISE(ABORT,'nectar_guard_revenue_source_changed'); END;
CREATE TRIGGER nc_revenue_credit_immutable BEFORE UPDATE ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_revenue_credit_keep BEFORE DELETE ON nc_revenue_credits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_insert AFTER INSERT ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_update AFTER UPDATE ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_revenue_credits_delete AFTER DELETE ON nc_revenue_credits
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
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
CREATE TRIGGER nc_usage_credit_source BEFORE INSERT ON nc_credit_notes
WHEN NEW.correction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
 SELECT 1 FROM nc_usage_corrections c JOIN nc_invoices i ON i.id=NEW.invoice_id
 WHERE c.id=NEW.correction_id AND c.status='approved' AND c.customer_id=NEW.customer_id AND i.customer_id=NEW.customer_id
 AND NEW.subtotal_cents+NEW.tax_cents=NEW.amount_cents AND NEW.applied_cents IS NOT NULL
) BEGIN SELECT RAISE(ABORT,'nectar_guard_correction_source_changed'); END;
