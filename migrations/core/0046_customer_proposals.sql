-- PORT-005: retain an honest customer preparer kind without operator authority.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE nc_proposals_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('amendment', 'price_change', 'usage_correction', 'collection')),
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('member', 'agent', 'customer')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  result_json TEXT
, prepared_by_id TEXT);
INSERT INTO nc_proposals_next (id,kind,title,payload_json,evidence_json,impact_json,basis_json,status,created_by,created_by_kind,created_at,decided_by,decided_at,decision_note,result_json,prepared_by_id) SELECT id,kind,title,payload_json,evidence_json,impact_json,basis_json,status,created_by,created_by_kind,created_at,decided_by,decided_at,decision_note,result_json,prepared_by_id FROM nc_proposals;
DROP TRIGGER nc_draft_correction_mail_insert;
DROP TRIGGER nc_draft_correction_mail_outcome;
DROP TABLE nc_proposals;
ALTER TABLE nc_proposals_next RENAME TO nc_proposals;
CREATE TRIGGER nc_draft_correction_mail_insert BEFORE INSERT ON nc_draft_correction_mail
 WHEN (NEW.status<>'pending' OR NEW.provider_ref IS NOT NULL OR NEW.outcome_code IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND kind=NEW.proposal_kind AND status IN ('pending','approved'))) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_draft_correction_mail_outcome BEFORE UPDATE ON nc_draft_correction_mail
 WHEN (NOT ((OLD.status='pending' AND NEW.status='sending' AND NEW.provider_ref IS NULL AND NEW.outcome_code IS NULL
   AND EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND status='approved'))
 OR (OLD.status='sending' AND NEW.status IN ('accepted','failed','rejected','uncertain','suppressed')))) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_delete AFTER DELETE ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_insert AFTER INSERT ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_update AFTER UPDATE ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_proposal_insert BEFORE INSERT ON nc_proposals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(NEW.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_proposal_update BEFORE UPDATE ON nc_proposals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(NEW.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
  OR EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(OLD.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_proposal_content BEFORE UPDATE OF kind,title,payload_json,evidence_json,impact_json,basis_json,created_by,created_by_kind,created_at,prepared_by_id ON nc_proposals  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_proposals_decided BEFORE UPDATE ON nc_proposals WHEN (OLD.status <> 'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

-- Dropping the old parent records deferred violations against its former
-- b-tree, even though the replacement contains every original key. Validate
-- the final relationships before clearing that obsolete deferred counter and
-- returning to immediate checking. No foreign-key enforcement is disabled.
INSERT INTO nc_guard(code,ok) SELECT 'customer_proposal_migration',CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DELETE FROM nc_guard WHERE code='customer_proposal_migration';
PRAGMA defer_foreign_keys = OFF;
