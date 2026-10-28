-- Customer-confirmed hosted ACH payment for one issued invoice balance.
CREATE TABLE nc_portal_invoice_payments (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id), invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL, binding_id TEXT NOT NULL, binding_revision TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, source_hash TEXT NOT NULL, consent_hash TEXT NOT NULL,
 status TEXT NOT NULL, session_ref TEXT, intent_ref TEXT, payment_id TEXT REFERENCES nc_payments(id),
 created_at INTEGER NOT NULL, revision TEXT NOT NULL
);
CREATE UNIQUE INDEX nc_portal_invoice_payment_active ON nc_portal_invoice_payments(invoice_id) WHERE status NOT IN ('expired','failed');
CREATE UNIQUE INDEX nc_portal_invoice_payment_session ON nc_portal_invoice_payments(account_ref,session_ref) WHERE session_ref IS NOT NULL;
CREATE TABLE nc_portal_invoice_payment_authority (
 id TEXT PRIMARY KEY REFERENCES nc_portal_invoice_payments(id) ON DELETE CASCADE,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), created_at INTEGER NOT NULL
);
CREATE TRIGGER nc_portal_invoice_payment_no_other BEFORE INSERT ON nc_portal_invoice_payments
WHEN EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=NEW.invoice_id)
 OR EXISTS(SELECT 1 FROM nc_automatic_collections WHERE invoice_id=NEW.invoice_id AND status NOT IN ('revoked','invalidated'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_payment_managed'); END;
CREATE TRIGGER nc_native_collection_no_portal BEFORE INSERT ON nc_native_collection_claims
WHEN EXISTS(SELECT 1 FROM nc_portal_invoice_payments WHERE invoice_id=NEW.invoice_id AND status NOT IN ('expired','failed'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_payment_managed'); END;
CREATE TRIGGER nc_automatic_collection_no_portal BEFORE INSERT ON nc_automatic_collections
WHEN EXISTS(SELECT 1 FROM nc_portal_invoice_payments WHERE invoice_id=NEW.invoice_id AND status NOT IN ('expired','failed'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_payment_managed'); END;
CREATE TRIGGER nc_portal_invoice_payment_generation_insert AFTER INSERT ON nc_portal_invoice_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_invoice_payment_generation_update AFTER UPDATE ON nc_portal_invoice_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_invoice_payment_generation_delete AFTER DELETE ON nc_portal_invoice_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_invoice_authority_generation_insert AFTER INSERT ON nc_portal_invoice_payment_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_invoice_authority_generation_delete AFTER DELETE ON nc_portal_invoice_payment_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
