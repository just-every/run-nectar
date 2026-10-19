-- Proposal-bound GOV002 requests cannot be issued through the standalone door.
CREATE TABLE nc_credit_correction_requests (
 proposal_id TEXT PRIMARY KEY REFERENCES nc_proposals(id),
 request_id TEXT NOT NULL UNIQUE REFERENCES nc_credit_requests(id),
 prepared_at INTEGER NOT NULL
);
CREATE TRIGGER nc_credit_correction_request_immutable BEFORE UPDATE ON nc_credit_correction_requests BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_credit_correction_request_keep BEFORE DELETE ON nc_credit_correction_requests BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

-- The proposal itself holds the immutable preview; mail freezes its approved wording.
CREATE TABLE nc_credit_correction_mail (
 proposal_id TEXT PRIMARY KEY REFERENCES nc_proposals(id),
 credit_id TEXT NOT NULL UNIQUE REFERENCES nc_credit_notes(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 explanation TEXT NOT NULL, citations_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','uncertain','suppressed')),
 provider_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX nc_credit_correction_mail_pending ON nc_credit_correction_mail(status,created_at);
CREATE TRIGGER nc_credit_correction_mail_content BEFORE UPDATE OF proposal_id,credit_id,customer_id,recipient,subject,body,explanation,citations_json,created_at ON nc_credit_correction_mail BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_credit_correction_mail_keep BEFORE DELETE ON nc_credit_correction_mail BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_credit_correction_mail_outcome BEFORE UPDATE ON nc_credit_correction_mail WHEN NOT ((OLD.status='pending' AND NEW.status='sending') OR (OLD.status='sending' AND NEW.status IN ('accepted','failed','uncertain','suppressed'))) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
