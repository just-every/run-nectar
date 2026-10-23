-- Explicit owner choice; existing outcomes are never backfilled or mailed.
CREATE TABLE nc_prepaid_refund_mail_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),refunded_sender TEXT NOT NULL DEFAULT 'off' CHECK(refunded_sender IN ('off','nectar','processor')),
 failed_sender TEXT NOT NULL DEFAULT 'off' CHECK(failed_sender IN ('off','nectar','processor')),
 templates_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(templates_json)),revision INTEGER NOT NULL DEFAULT 0,configured_by TEXT,configured_at INTEGER);
INSERT INTO nc_prepaid_refund_mail_settings(id) VALUES(1);
CREATE TABLE nc_prepaid_refund_mail(
 refund_id TEXT PRIMARY KEY REFERENCES nc_prepaid_refunds(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 kind TEXT NOT NULL CHECK(kind IN ('refunded','failed')),source TEXT NOT NULL CHECK(source IN ('off','nectar','processor')),
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','uncertain','suppressed','off','processor')),
 templates_json TEXT NOT NULL CHECK(json_valid(templates_json)),recipient TEXT NOT NULL DEFAULT '',mail_subject TEXT NOT NULL DEFAULT '',mail_body TEXT NOT NULL DEFAULT '',language TEXT NOT NULL DEFAULT '',
 provider_ref TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TRIGGER nc_prepaid_refund_mail_reserve AFTER UPDATE OF status ON nc_prepaid_refunds WHEN NEW.status IN ('refunded','failed') AND OLD.status<>NEW.status AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN
 INSERT INTO nc_prepaid_refund_mail(refund_id,customer_id,kind,source,status,templates_json,created_at,updated_at)
 SELECT NEW.id,NEW.customer_id,NEW.status,CASE NEW.status WHEN 'refunded' THEN refunded_sender ELSE failed_sender END,
 CASE CASE NEW.status WHEN 'refunded' THEN refunded_sender ELSE failed_sender END WHEN 'nectar' THEN 'pending' WHEN 'processor' THEN 'processor' ELSE 'off' END,
 templates_json,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000 FROM nc_prepaid_refund_mail_settings WHERE id=1;
END;
CREATE TRIGGER nc_prepaid_refund_mail_keep BEFORE DELETE ON nc_prepaid_refund_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_prepaid_refund_mail_content BEFORE UPDATE ON nc_prepaid_refund_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
 OLD.refund_id IS NOT NEW.refund_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.kind IS NOT NEW.kind OR OLD.source IS NOT NEW.source OR OLD.templates_json IS NOT NEW.templates_json OR OLD.created_at IS NOT NEW.created_at OR
 NOT(OLD.status='pending' AND NEW.status IN ('sending','off','processor','failed') OR OLD.status='sending' AND NEW.status IN ('accepted','failed','uncertain','suppressed')) OR
 OLD.status='sending' AND (OLD.recipient IS NOT NEW.recipient OR OLD.mail_subject IS NOT NEW.mail_subject OR OLD.mail_body IS NOT NEW.mail_body OR OLD.language IS NOT NEW.language)
) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_prepaid_refund_mail_owned_insert BEFORE INSERT ON nc_prepaid_refund_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_prepaid_refund_mail_owned_update BEFORE UPDATE ON nc_prepaid_refund_mail WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (OLD.customer_id,NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_prepaid_refund_mail_generation_insert AFTER INSERT ON nc_prepaid_refund_mail BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_prepaid_refund_mail_generation_update AFTER UPDATE ON nc_prepaid_refund_mail BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_prepaid_refund_mail_generation_delete AFTER DELETE ON nc_prepaid_refund_mail BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
