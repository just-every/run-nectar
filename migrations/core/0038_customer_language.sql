-- PORT-006: the language customer-facing mail and pages use; a tag naming a
-- complete translation file (src/nectar/locales/<tag>.json). English by default.
ALTER TABLE nc_customers ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
