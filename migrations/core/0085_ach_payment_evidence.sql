-- Closed historical cash facts only: this table never authorizes a debit.
-- Native association must be provider PaymentIntent.metadata.nectar_native_invoice.
CREATE TABLE nc_ach_payment_evidence (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 payment_id TEXT NOT NULL UNIQUE REFERENCES nc_payments(id),
 allocation_id TEXT NOT NULL UNIQUE REFERENCES nc_allocations(id),
 account_ref TEXT NOT NULL,
 stripe_customer_ref TEXT NOT NULL,
 payment_intent_ref TEXT NOT NULL,
 charge_ref TEXT NOT NULL,
 payment_method_ref TEXT NOT NULL,
 settlement_ref TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 currency TEXT NOT NULL CHECK(length(currency)=3),
 bank_name TEXT NOT NULL,
 last4 TEXT NOT NULL CHECK(last4='' OR (length(last4)=4 AND last4 NOT GLOB '*[^0-9]*')),
 livemode INTEGER NOT NULL CHECK(livemode IN(0,1)),
 captured_at INTEGER NOT NULL,
 settled_at INTEGER NOT NULL,
 verified_at INTEGER NOT NULL,
 verified_by TEXT NOT NULL
);
CREATE INDEX nc_ach_payment_evidence_customer ON nc_ach_payment_evidence(customer_id,verified_at,id);
-- Empty provider fields are permitted solely for the generic privacy scrub.
CREATE UNIQUE INDEX nc_ach_payment_evidence_intent ON nc_ach_payment_evidence(account_ref,payment_intent_ref) WHERE payment_intent_ref<>'';
CREATE UNIQUE INDEX nc_ach_payment_evidence_charge ON nc_ach_payment_evidence(account_ref,charge_ref) WHERE charge_ref<>'';
CREATE TRIGGER nc_ach_payment_evidence_source BEFORE INSERT ON nc_ach_payment_evidence
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NEW.payment_intent_ref='' OR NEW.charge_ref='' OR NEW.settlement_ref='' OR NEW.last4=''
 OR NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_allocations a ON a.payment_id=p.id JOIN nc_invoices i ON i.id=a.invoice_id
 JOIN nc_customers c ON c.id=i.customer_id
 WHERE p.id=NEW.payment_id AND a.id=NEW.allocation_id AND i.id=NEW.invoice_id AND c.id=NEW.customer_id
 AND p.customer_id=c.id AND p.amount_cents=NEW.amount_cents AND a.amount_cents=NEW.amount_cents
 AND lower(p.currency)=NEW.currency AND lower(i.currency)=NEW.currency AND p.method='bank_transfer'
 AND c.erased_at IS NULL AND c.status='active' AND i.status='issued'
 AND p.reference='stripe:'||NEW.account_ref||':'||NEW.payment_intent_ref)
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(NEW.customer_id,NEW.invoice_id))
 OR EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=NEW.invoice_id)
 OR EXISTS(SELECT 1 FROM nc_native_collections WHERE account_ref=NEW.account_ref AND (payment_intent_ref=NEW.payment_intent_ref OR charge_ref=NEW.charge_ref)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_ach_payment_evidence_invalid'); END;
CREATE TRIGGER nc_ach_payment_evidence_update BEFORE UPDATE ON nc_ach_payment_evidence
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ach_payment_evidence_delete BEFORE DELETE ON nc_ach_payment_evidence
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ach_payment_evidence_generation_insert AFTER INSERT ON nc_ach_payment_evidence BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ach_payment_evidence_generation_update AFTER UPDATE ON nc_ach_payment_evidence BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ach_payment_evidence_generation_delete AFTER DELETE ON nc_ach_payment_evidence BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
