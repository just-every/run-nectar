-- MOVE-011: imported credit notes share custody, never invoice balances.
ALTER TABLE nc_incumbent_invoices ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'invoice' CHECK(document_kind IN ('invoice','credit-note'));
ALTER TABLE nc_business ADD COLUMN credit_prefix TEXT;
ALTER TABLE nc_business ADD COLUMN credit_number_width INTEGER NOT NULL DEFAULT 6;
UPDATE nc_business SET credit_prefix=invoice_prefix || '-CN-';
ALTER TABLE nc_customers ADD COLUMN credit_prefix TEXT;
ALTER TABLE nc_customers ADD COLUMN credit_number_width INTEGER;
ALTER TABLE nc_customers ADD COLUMN next_credit_number INTEGER;
