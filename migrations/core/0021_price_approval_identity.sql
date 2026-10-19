-- Existing member proposals retain their attribution, but must be prepared
-- again before a price approval: labels are not stable member identities.
ALTER TABLE nc_proposals ADD COLUMN prepared_by_id TEXT;
CREATE TRIGGER nc_proposal_content BEFORE UPDATE OF kind,title,payload_json,evidence_json,impact_json,basis_json,created_by,created_by_kind,created_at,prepared_by_id ON nc_proposals BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
