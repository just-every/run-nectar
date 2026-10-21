-- Access thresholds do not change contractual prices or issued invoices.
CREATE TABLE nc_feature_policies (
  product_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  meter_id TEXT REFERENCES nc_meters(id),
  quota TEXT,
  quota_policy TEXT NOT NULL CHECK(quota_policy IN ('soft','hard','overage')),
  grace_days INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, feature),
  FOREIGN KEY(product_id, feature) REFERENCES nc_features(product_id, feature)
);
