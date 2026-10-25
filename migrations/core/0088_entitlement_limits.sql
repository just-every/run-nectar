-- Numeric access limits use the existing independently approved feature policy.
ALTER TABLE nc_feature_policies ADD COLUMN numeric_limit TEXT;
