CREATE TABLE nc_usage_controls (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  meter_id TEXT NOT NULL REFERENCES nc_meters(id),
  day TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  expected_quantity TEXT NOT NULL,
  revision TEXT NOT NULL,
  acknowledged_basis TEXT,
  acknowledged_by TEXT,
  acknowledged_reason TEXT,
  UNIQUE(customer_id, meter_id, day)
);
