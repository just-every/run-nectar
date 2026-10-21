-- MOVE-011: preserve captured invoice suffix widths and customer sequences.
ALTER TABLE nc_business ADD COLUMN invoice_number_width INTEGER NOT NULL DEFAULT 6;
ALTER TABLE nc_customers ADD COLUMN invoice_prefix TEXT;
ALTER TABLE nc_customers ADD COLUMN invoice_number_width INTEGER;
ALTER TABLE nc_customers ADD COLUMN next_invoice_number INTEGER;

-- These guards also cover imports or concurrent issue paths within one D1 batch.
CREATE TRIGGER nc_invoice_imported_number BEFORE UPDATE OF number,status ON nc_invoices
WHEN NEW.status='issued' AND EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE number=NEW.number)
BEGIN SELECT RAISE(ABORT,'nectar_guard_number_already_used'); END;
CREATE TRIGGER nc_credit_imported_number BEFORE INSERT ON nc_credit_notes
WHEN EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE number=NEW.number)
BEGIN SELECT RAISE(ABORT,'nectar_guard_number_already_used'); END;
CREATE TRIGGER nc_import_native_number BEFORE INSERT ON nc_incumbent_invoices
WHEN NEW.number<>'' AND (EXISTS(SELECT 1 FROM nc_invoices WHERE status='issued' AND number=NEW.number) OR EXISTS(SELECT 1 FROM nc_credit_notes WHERE number=NEW.number))
BEGIN SELECT RAISE(ABORT,'nectar_guard_number_already_used'); END;
