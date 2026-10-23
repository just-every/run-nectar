-- Presentation is captured with approved invoice inputs.
ALTER TABLE nc_business ADD COLUMN invoice_branding_json TEXT NOT NULL DEFAULT '{}';
