-- INV-004: current preferences are separate from immutable invoice inputs.
ALTER TABLE nc_business ADD COLUMN invoice_fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nc_customers ADD COLUMN invoice_settings_json TEXT NOT NULL DEFAULT '{}';
