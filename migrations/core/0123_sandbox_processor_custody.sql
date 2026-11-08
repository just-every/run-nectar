-- Retained test-object custody survives archives without debit authority.
CREATE TABLE nc_sandbox_processor_records (
 customer_id TEXT PRIMARY KEY REFERENCES nc_sandbox_customers(id),
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL UNIQUE, method_ref TEXT NOT NULL
);
INSERT INTO nc_sandbox_processor_records(customer_id,account_ref,customer_ref,method_ref)
 SELECT customer_id,account_ref,customer_ref,method_ref FROM nc_sandbox_processor_authority;
DROP TRIGGER nc_sandbox_reject_live_binding;
CREATE TRIGGER nc_sandbox_reject_live_binding BEFORE INSERT ON nc_stripe_customer_bindings
WHEN EXISTS(SELECT 1 FROM nc_sandbox_processor_records WHERE customer_ref=NEW.stripe_customer_ref)
BEGIN SELECT RAISE(ABORT,'nectar_guard_sandbox_live_customer_refused'); END;
CREATE TRIGGER nc_sandbox_processor_record_fixed BEFORE UPDATE ON nc_sandbox_processor_records
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
