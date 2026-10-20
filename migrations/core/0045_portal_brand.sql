-- PORT-005: owner-controlled customer portal presentation.
ALTER TABLE nc_portal_policy ADD COLUMN brand_name TEXT NOT NULL DEFAULT '';
ALTER TABLE nc_portal_policy ADD COLUMN brand_color TEXT NOT NULL DEFAULT '#245c46';
