-- GOV-001: billing roles beyond NEC-15. Preset collections, sales, support and
-- developer roles, owner-defined custom roles built from explicit
-- capabilities, and the owner-set support credit limit (zero until set).
CREATE TABLE nc_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX nc_roles_name ON nc_roles(lower(name));

PRAGMA defer_foreign_keys = ON;
CREATE TABLE nc_members_next (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'finance', 'accountant', 'collections', 'sales', 'support', 'developer', 'custom')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  custom_role_id TEXT REFERENCES nc_roles(id),
  CHECK ((role = 'custom') = (custom_role_id IS NOT NULL))
);
INSERT INTO nc_members_next (id,email,name,role,status,created_at,updated_at) SELECT id,email,name,role,status,created_at,updated_at FROM nc_members;
DROP TABLE nc_members;
ALTER TABLE nc_members_next RENAME TO nc_members;
-- Same final-relationship check as 0046 before returning to immediate checking.
INSERT INTO nc_guard(code,ok) SELECT 'billing_roles_migration',CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DELETE FROM nc_guard WHERE code='billing_roles_migration';
PRAGMA defer_foreign_keys = OFF;

ALTER TABLE nc_credit_policy ADD COLUMN support_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK (support_limit_cents >= 0);
