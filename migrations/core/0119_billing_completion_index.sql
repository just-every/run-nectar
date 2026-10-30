-- A completion check asks only whether unissued work remains.
-- Keep the indexed search bounded as a billing day grows.
CREATE INDEX nc_invoices_run_status ON nc_invoices(bill_run_id,status);
