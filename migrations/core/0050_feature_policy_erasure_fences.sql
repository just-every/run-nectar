-- Preserve erasure authorization and restore-generation fences when extending policy kinds.
DROP TRIGGER nc_policy_change_content;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_decided;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_keep;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_insert AFTER INSERT ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_update AFTER UPDATE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_delete AFTER DELETE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
