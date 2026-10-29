-- Historical checkpoints are portable; execution authority is installation-local.
ALTER TABLE nc_invoice_automation_runs ADD COLUMN execution_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE nc_invoice_automation_runs ADD COLUMN heartbeat_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nc_invoice_automation_runs ADD COLUMN resumption_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE nc_invoice_automation_periods (
  automation_id TEXT NOT NULL REFERENCES nc_invoice_automation_runs(id),
  period TEXT NOT NULL,
  bill_run_id TEXT NOT NULL REFERENCES nc_bill_runs(id),
  PRIMARY KEY(automation_id,period),
  UNIQUE(bill_run_id)
);
CREATE TABLE nc_invoice_automation_authority (
  automation_id TEXT PRIMARY KEY REFERENCES nc_invoice_automation_runs(id),
  revision TEXT NOT NULL
);
