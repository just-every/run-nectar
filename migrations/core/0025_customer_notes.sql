CREATE TABLE nc_notes (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 kind TEXT NOT NULL CHECK(kind IN ('customer','invoice','payment')),
 record_id TEXT NOT NULL,
 record_label TEXT NOT NULL,
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 author_id TEXT NOT NULL REFERENCES nc_members(id),
 author TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX nc_notes_customer ON nc_notes(customer_id,created_at,id);
CREATE INDEX nc_notes_record ON nc_notes(kind,record_id,created_at,id);
CREATE TRIGGER nc_notes_immutable BEFORE UPDATE ON nc_notes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_notes_keep BEFORE DELETE ON nc_notes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TABLE nc_note_mentions (
 note_id TEXT NOT NULL REFERENCES nc_notes(id),
 member_id TEXT NOT NULL REFERENCES nc_members(id),
 email TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','suppressed','failed','uncertain')),
 provider_ref TEXT,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(note_id,member_id)
);
CREATE TRIGGER nc_note_mentions_content BEFORE UPDATE OF note_id,member_id,email ON nc_note_mentions BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_note_mentions_keep BEFORE DELETE ON nc_note_mentions BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
