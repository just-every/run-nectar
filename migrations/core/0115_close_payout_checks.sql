-- Read-only provider comparisons are observations, never received funds.
CREATE TABLE nc_payout_checks(
 id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, payout_ref TEXT NOT NULL,
 currency TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL,
 automatic INTEGER NOT NULL CHECK(automatic IN (0,1)), occurred_at INTEGER NOT NULL,
 gross_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL,
 difference_cents INTEGER NOT NULL, error_code TEXT, basis_hash TEXT NOT NULL,
 members_json TEXT NOT NULL CHECK(json_valid(members_json)), observed_at INTEGER NOT NULL,
 UNIQUE(account_ref,payout_ref));
CREATE TRIGGER nc_payout_checks_generation_insert AFTER INSERT ON nc_payout_checks BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payout_checks_generation_update AFTER UPDATE ON nc_payout_checks BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payout_checks_generation_delete AFTER DELETE ON nc_payout_checks BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
