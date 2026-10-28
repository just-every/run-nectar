-- A deposit reconciles a payout; it never records the constituent payments again.
CREATE TABLE nc_bank_payout_matches(
 id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 account_ref TEXT NOT NULL, payout_ref TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 received_on TEXT NOT NULL, matched_by TEXT NOT NULL, matched_at INTEGER NOT NULL,
 UNIQUE(account_ref,payout_ref)
);
CREATE TRIGGER nc_bank_payout_matches_immutable BEFORE UPDATE ON nc_bank_payout_matches
 WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_bank_payout_matches_keep BEFORE DELETE ON nc_bank_payout_matches
 WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
