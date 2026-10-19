CREATE TABLE nc_price_requests (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES nc_products(id), version INTEGER NOT NULL, meter_id TEXT REFERENCES nc_meters(id),
 payload_json TEXT NOT NULL, prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','published','rejected')) DEFAULT 'pending',
 decided_by TEXT, decided_at INTEGER, approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver')),
 price_id TEXT REFERENCES nc_prices(id)
);
CREATE TRIGGER nc_price_request_content BEFORE UPDATE OF product_id,version,meter_id,payload_json,prepared_by_id,prepared_by,prepared_at ON nc_price_requests BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_price_request_decided BEFORE UPDATE ON nc_price_requests WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_price_request_keep BEFORE DELETE ON nc_price_requests BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
