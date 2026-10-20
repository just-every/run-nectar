-- GOV-007. Required multi-factor sign-in. Authenticator-app secrets are sealed
-- under the installation's MFA_KEY (AES-GCM), never the session secret, so an
-- archive carries only sealed values. Passkeys keep public keys; recovery codes
-- keep SHA-256 hashes. Per-session checks and WebAuthn challenges are transient
-- and never enter an archive.
CREATE TABLE nc_mfa_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  scope TEXT NOT NULL CHECK(scope IN ('off','roles','all')),
  roles TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE nc_mfa_factors (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES nc_members(id),
  kind TEXT NOT NULL CHECK(kind IN ('totp','passkey')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active')),
  sealed_secret TEXT,
  last_step INTEGER NOT NULL DEFAULT 0,
  credential_id TEXT UNIQUE,
  public_key TEXT CHECK(public_key IS NULL OR json_valid(public_key)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  CHECK((kind = 'totp' AND sealed_secret IS NOT NULL) OR (kind = 'passkey' AND credential_id IS NOT NULL AND public_key IS NOT NULL))
);
CREATE INDEX nc_mfa_factors_member ON nc_mfa_factors(member_id);
CREATE TABLE nc_mfa_recovery (
  member_id TEXT NOT NULL REFERENCES nc_members(id),
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY(member_id, code_hash)
);
CREATE TABLE nc_mfa_sessions (
  session_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  method TEXT NOT NULL
);
CREATE TABLE nc_mfa_challenges (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','verify')),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
