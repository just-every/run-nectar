-- Human-approved draft adjustments and their frozen customer mail queue commit together.
CREATE TABLE nc_draft_correction_mail (
 proposal_id TEXT NOT NULL REFERENCES nc_proposals(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 proposal_kind TEXT NOT NULL CHECK(proposal_kind IN ('amendment','usage_correction')),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, citations_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','rejected','uncertain','suppressed')),
 provider_ref TEXT, outcome_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(proposal_id,customer_id)
);
CREATE INDEX nc_draft_correction_mail_pending ON nc_draft_correction_mail(status,created_at);
CREATE TRIGGER nc_draft_correction_mail_content BEFORE UPDATE OF proposal_id,customer_id,proposal_kind,recipient,subject,body,citations_json,created_at
 ON nc_draft_correction_mail BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_draft_correction_mail_keep BEFORE DELETE ON nc_draft_correction_mail BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_draft_correction_mail_insert BEFORE INSERT ON nc_draft_correction_mail
 WHEN NEW.status<>'pending' OR NEW.provider_ref IS NOT NULL OR NEW.outcome_code IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND kind=NEW.proposal_kind AND status IN ('pending','approved'))
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_draft_correction_mail_outcome BEFORE UPDATE ON nc_draft_correction_mail
 WHEN NOT ((OLD.status='pending' AND NEW.status='sending' AND NEW.provider_ref IS NULL AND NEW.outcome_code IS NULL
   AND EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND status='approved'))
 OR (OLD.status='sending' AND NEW.status IN ('accepted','failed','rejected','uncertain','suppressed')))
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
