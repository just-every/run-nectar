-- A contact binding is server-owned; customer session claims carry no recipient identity.
CREATE TABLE nc_portal_session_contacts (
  session_id TEXT PRIMARY KEY REFERENCES nc_portal_sessions(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES nc_contacts(id) ON DELETE CASCADE
);
CREATE INDEX nc_portal_session_contacts_contact ON nc_portal_session_contacts(contact_id);
CREATE TRIGGER nc_portal_session_contacts_generation_insert AFTER INSERT ON nc_portal_session_contacts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_session_contacts_generation_update AFTER UPDATE ON nc_portal_session_contacts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_session_contacts_generation_delete AFTER DELETE ON nc_portal_session_contacts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
