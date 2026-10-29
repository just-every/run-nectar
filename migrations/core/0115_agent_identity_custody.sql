-- Operator identities belong to this installation, not portable billing data.
-- Preserve the existing binding while moving its foreign key out of nc_members.
CREATE TABLE oa_nectar_members (
  member_id TEXT PRIMARY KEY REFERENCES nc_members(id),
  operator_id TEXT NOT NULL UNIQUE REFERENCES oa_operators(id)
);
INSERT INTO oa_nectar_members(member_id,operator_id)
SELECT id,operator_id FROM nc_members WHERE operator_id IS NOT NULL;
DROP INDEX nc_members_operator;
ALTER TABLE nc_members DROP COLUMN operator_id;
