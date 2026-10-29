-- Shared payout reconciliation is evidence only and creates no customer payment.
CREATE TABLE nc_bank_payout_matches (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES nc_remittances(id),
 processor_account TEXT NOT NULL, payout_ref TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 basis_hash TEXT NOT NULL, matched_at INTEGER NOT NULL, matched_by TEXT NOT NULL,
 UNIQUE(processor_account,payout_ref)
);
CREATE TRIGGER nc_bank_payout_matches_update BEFORE UPDATE ON nc_bank_payout_matches
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_bank_payout_matches_delete BEFORE DELETE ON nc_bank_payout_matches
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_bank_payout_matches_generation_insert AFTER INSERT ON nc_bank_payout_matches BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_bank_payout_matches_generation_update AFTER UPDATE ON nc_bank_payout_matches BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_bank_payout_matches_generation_delete AFTER DELETE ON nc_bank_payout_matches BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
