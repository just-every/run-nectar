-- Issued consideration retains its original tax and recognition allocation.
-- A recurring invoice claims each settlement once in its ordinary issue batch.
CREATE TABLE nc_threshold_settlements (
 invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id),
 crossing_id TEXT NOT NULL UNIQUE REFERENCES nc_usage_crossings(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 cutoff_at INTEGER NOT NULL,
 source_fingerprint TEXT NOT NULL,
 subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>0),
 tax_cents INTEGER NOT NULL,
 revenue_json TEXT NOT NULL,
 remainder_invoice_id TEXT REFERENCES nc_invoices(id),
 created_at INTEGER NOT NULL
);
CREATE INDEX nc_threshold_settlements_window ON nc_threshold_settlements(subscription_id,period_start,period_end);
CREATE TRIGGER nc_threshold_settlement_source BEFORE INSERT ON nc_threshold_settlements
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NOT EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_usage_crossings c ON c.id=NEW.crossing_id
   WHERE i.id=NEW.invoice_id AND i.status='issued' AND i.invoice_kind='manual'
   AND i.customer_id=NEW.customer_id AND i.subscription_id=NEW.subscription_id
   AND i.source_fingerprint=NEW.source_fingerprint AND i.subtotal_cents=NEW.subtotal_cents AND i.tax_cents=NEW.tax_cents
   AND c.invoice_id=i.id AND json_extract(i.calculation_json,'$.inputs.thresholdInvoice.crossing')=c.id)
 BEGIN SELECT RAISE(ABORT,'nectar_guard_threshold_source_changed'); END;
CREATE TRIGGER nc_threshold_settlement_content BEFORE UPDATE OF invoice_id,crossing_id,customer_id,subscription_id,period_start,period_end,cutoff_at,source_fingerprint,subtotal_cents,tax_cents,revenue_json,created_at ON nc_threshold_settlements
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_threshold_settlement_claim BEFORE UPDATE OF remainder_invoice_id ON nc_threshold_settlements
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.remainder_invoice_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM nc_invoices i WHERE i.id=NEW.remainder_invoice_id AND i.status='issued' AND i.invoice_kind='recurring' AND i.subscription_id=NEW.subscription_id))
 BEGIN SELECT RAISE(ABORT,'nectar_guard_threshold_already_settled'); END;
CREATE TRIGGER nc_threshold_settlement_keep BEFORE DELETE ON nc_threshold_settlements
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_threshold_settlements_generation_insert AFTER INSERT ON nc_threshold_settlements BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_threshold_settlements_generation_update AFTER UPDATE ON nc_threshold_settlements BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_threshold_settlements_generation_delete AFTER DELETE ON nc_threshold_settlements BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
