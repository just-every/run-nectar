-- Bind native people and application credentials once, independently of email.
ALTER TABLE nc_members ADD COLUMN operator_id TEXT REFERENCES oa_operators(id);
CREATE UNIQUE INDEX nc_members_operator ON nc_members(operator_id) WHERE operator_id IS NOT NULL;
UPDATE nc_members SET operator_id=(SELECT id FROM oa_operators WHERE email=nc_members.email)
WHERE operator_id IS NULL;
ALTER TABLE nc_agent_keys ADD COLUMN sponsor_member_id TEXT REFERENCES nc_members(id);
-- Old keys saved only an author address. Do not infer their sponsor from a
-- possibly reused address: reissue through the existing native key lifecycle.
