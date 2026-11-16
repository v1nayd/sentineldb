-- 0003 — Audit retention (ADR-4, defect D3): evidence and audit rows can no longer disappear through a foreign key.
--
-- Phase 1 used ON DELETE CASCADE / SET NULL on most foreign keys. Two problems:
--   * Deleting an incident silently deleted its status history and notes (D3, probed on real MySQL).
--   * InnoDB does NOT fire triggers for rows changed by a cascading foreign-key action. A cascade would therefore
--     delete evidence links or null out actors without leaving any audit row, bypassing every trigger added in M2.
-- Policy instead: users are never deleted (deactivated in M3), incidents are archived (0004), evidence is unlinked
-- explicitly (audited by 0008). Every foreign key that touches evidence or attribution becomes RESTRICT, so even a
-- privileged DELETE of a referenced row fails loudly.
--
-- MySQL cannot change a foreign key's rule in place: each one is dropped and re-added under the same name.

ALTER TABLE Incident_Status_History DROP FOREIGN KEY fk_ish_incident, DROP FOREIGN KEY fk_ish_changed_by;
ALTER TABLE Incident_Status_History
  ADD CONSTRAINT fk_ish_incident   FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_ish_changed_by FOREIGN KEY (changed_by)  REFERENCES Users(user_id)         ON DELETE RESTRICT;

ALTER TABLE Notes DROP FOREIGN KEY fk_notes_incident;
ALTER TABLE Notes ADD CONSTRAINT fk_notes_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT;

ALTER TABLE Incidents DROP FOREIGN KEY fk_incidents_assigned_to;
ALTER TABLE Incidents ADD CONSTRAINT fk_incidents_assigned_to FOREIGN KEY (assigned_to) REFERENCES Users(user_id) ON DELETE RESTRICT;

ALTER TABLE Playbooks DROP FOREIGN KEY fk_playbooks_created_by;
ALTER TABLE Playbooks ADD CONSTRAINT fk_playbooks_created_by FOREIGN KEY (created_by) REFERENCES Users(user_id) ON DELETE RESTRICT;

ALTER TABLE Incident_IOC DROP FOREIGN KEY fk_iioc_incident, DROP FOREIGN KEY fk_iioc_ioc;
ALTER TABLE Incident_IOC
  ADD CONSTRAINT fk_iioc_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_iioc_ioc      FOREIGN KEY (ioc_id)      REFERENCES IOCs(ioc_id)           ON DELETE RESTRICT;

ALTER TABLE Incident_Asset DROP FOREIGN KEY fk_iasset_incident, DROP FOREIGN KEY fk_iasset_asset;
ALTER TABLE Incident_Asset
  ADD CONSTRAINT fk_iasset_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_iasset_asset    FOREIGN KEY (asset_id)    REFERENCES Assets(asset_id)       ON DELETE RESTRICT;

ALTER TABLE Incident_Playbook DROP FOREIGN KEY fk_ipb_incident, DROP FOREIGN KEY fk_ipb_playbook;
ALTER TABLE Incident_Playbook
  ADD CONSTRAINT fk_ipb_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_ipb_playbook FOREIGN KEY (playbook_id) REFERENCES Playbooks(playbook_id) ON DELETE RESTRICT;
