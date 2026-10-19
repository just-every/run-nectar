-- Human-authored context is separate from immutable money and rating evidence.
CREATE TABLE nc_metadata_revisions (
 kind TEXT NOT NULL CHECK(kind IN ('customer','subscription','price','invoice','payment','credit-note')),
 record_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
 author_id TEXT NOT NULL REFERENCES nc_members(id),
 author TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(kind,record_id,revision)
);
CREATE TRIGGER nc_metadata_values BEFORE INSERT ON nc_metadata_revisions
WHEN (SELECT COUNT(*) FROM json_each(NEW.metadata_json))>50
 OR EXISTS(SELECT 1 FROM json_each(NEW.metadata_json) WHERE type<>'text')
BEGIN SELECT RAISE(ABORT, 'nectar_invalid_metadata'); END;
CREATE TRIGGER nc_metadata_immutable BEFORE UPDATE ON nc_metadata_revisions
BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_metadata_keep BEFORE DELETE ON nc_metadata_revisions
BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
