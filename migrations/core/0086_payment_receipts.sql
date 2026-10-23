-- A receipt identifies recorded cash; allocation remains its own append-only ledger.
-- No customer names, references, provider payloads or financial originals are copied.
CREATE TABLE nc_payment_receipts (
 id TEXT PRIMARY KEY REFERENCES nc_payments(id),
 payment_id TEXT NOT NULL UNIQUE REFERENCES nc_payments(id),
 sequence INTEGER NOT NULL UNIQUE CHECK(typeof(sequence)='integer' AND sequence>0),
 number TEXT NOT NULL UNIQUE,
 CHECK(id=payment_id),
 CHECK(number='RCT-'||printf('%08d',sequence))
);
INSERT INTO nc_payment_receipts(id,payment_id,sequence,number)
 SELECT id,id,row_number() OVER(ORDER BY recorded_at,id),
 'RCT-'||printf('%08d',row_number() OVER(ORDER BY recorded_at,id)) FROM nc_payments;
-- The nonidentifying counter survives customer financial removal; a later
-- payment must never reuse a receipt number from a removed customer.
CREATE TABLE nc_payment_receipt_sequence (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0 AND value<=9007199254740991)
);
INSERT INTO nc_payment_receipt_sequence SELECT 1,COALESCE(MAX(sequence),0) FROM nc_payment_receipts;
CREATE TRIGGER nc_payment_receipt_sequence_update BEFORE UPDATE ON nc_payment_receipt_sequence
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NEW.singleton<>OLD.singleton OR NEW.value<>OLD.value+1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_payment_receipt_sequence_delete BEFORE DELETE ON nc_payment_receipt_sequence
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_payment_receipts_assign AFTER INSERT ON nc_payments
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN
 INSERT OR IGNORE INTO nc_payment_receipt_sequence(singleton,value)
 SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM nc_payment_receipts);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nc_payment_receipt_sequence WHERE singleton=1) THEN RAISE(ABORT,'nectar_receipt_sequence_required') END;
 UPDATE nc_payment_receipt_sequence SET value=value+1 WHERE singleton=1;
 INSERT INTO nc_payment_receipts(id,payment_id,sequence,number)
 SELECT NEW.id,NEW.id,value,'RCT-'||printf('%08d',value) FROM nc_payment_receipt_sequence WHERE singleton=1;
END;
CREATE TRIGGER nc_payment_receipts_update BEFORE UPDATE ON nc_payment_receipts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_payment_receipts_delete BEFORE DELETE ON nc_payment_receipts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_payment_receipts_generation_insert AFTER INSERT ON nc_payment_receipts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_receipts_generation_update AFTER UPDATE ON nc_payment_receipts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_receipts_generation_delete AFTER DELETE ON nc_payment_receipts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
