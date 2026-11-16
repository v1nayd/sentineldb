-- 0007 — Incident lifecycle triggers (defects D1, D2, D4, D6; ADR-2, ADR-6).
--
-- These triggers are the guarantee; the procedures in 0009 are the friendly front door. Whatever path changes an
-- incident (procedure, direct SQL by a privileged account, a future bug), the same rules run:
--   * an incident is created open, unassigned and unresolved, at the database clock;
--   * a status change must be listed in Status_Transitions, by someone allowed to make it, with a reason when required;
--   * closing requires every linked IOC reviewed and every linked asset's impact described (Phase 1 spec, close_incident);
--   * closed incidents are frozen (except reopening and archiving); archived incidents are frozen completely;
--   * resolved_at / updated_at / narrative_version are computed here and cannot be written by anyone;
--   * every status and assignment change writes exactly one audit row; a no-op UPDATE writes none (ADR-6).
--
-- MySQL notes: the spec's "AFTER UPDATE OF status" is PostgreSQL syntax; MySQL fires on every UPDATE, so the trigger
-- compares OLD and NEW itself, null-safely (<=>). Text is compared with utf8mb4_bin: under the default
-- case-insensitive collation 'Phishing' = 'phishing', but a narrative edit that only changes case must still bump
-- narrative_version (the embedding changes).
-- Error messages start with a stable code (SDBnn) that src/lib/lifecycle.ts maps to typed errors.

CREATE TRIGGER trg_incidents_before_insert BEFORE INSERT ON Incidents FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  DECLARE v_now DATETIME DEFAULT sdb_now();
  IF NOT (NEW.status <=> 'open') OR NEW.resolved_at IS NOT NULL OR NEW.assigned_to IS NOT NULL
     OR NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL OR NEW.archive_reason IS NOT NULL
     OR NOT (NEW.narrative_version <=> 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB10: a new incident starts open, unassigned and unresolved; use the lifecycle procedures';
  END IF;
  -- created_at is always the DB clock (an import session's @sentinel_clock when replaying history).
  SET NEW.created_at = v_now, NEW.updated_at = v_now;
END;

-- Every timeline starts with its origin row NULL -> open (ADR-2 item 7).
CREATE TRIGGER trg_incidents_after_insert AFTER INSERT ON Incidents FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  INSERT INTO Incident_Status_History
    (incident_id, old_status, new_status, changed_by, actor_name_snapshot, db_account, source, reason, changed_at)
  VALUES
    (NEW.incident_id, NULL, 'open', v_actor, sdb_user_name(v_actor), USER(), sdb_source(), NULL, NEW.created_at);
END;

CREATE TRIGGER trg_incidents_before_update BEFORE UPDATE ON Incidents FOR EACH ROW
trg: BEGIN
  DECLARE v_actor INT;
  DECLARE v_role VARCHAR(20);
  DECLARE v_now DATETIME;
  DECLARE v_allowed INT DEFAULT 0;
  DECLARE v_req_role VARCHAR(20);
  DECLARE v_req_reason BOOLEAN DEFAULT FALSE;
  DECLARE v_pending INT DEFAULT 0;
  DECLARE v_undocumented INT DEFAULT 0;
  DECLARE v_msg VARCHAR(128);
  DECLARE v_status_changed   BOOLEAN DEFAULT NOT (NEW.status <=> OLD.status);
  DECLARE v_assignee_changed BOOLEAN DEFAULT NOT (NEW.assigned_to <=> OLD.assigned_to);
  DECLARE v_narrative_changed BOOLEAN DEFAULT NOT (NEW.narrative COLLATE utf8mb4_bin <=> OLD.narrative COLLATE utf8mb4_bin);
  DECLARE v_descr_changed BOOLEAN DEFAULT
       NOT (NEW.narrative COLLATE utf8mb4_bin <=> OLD.narrative COLLATE utf8mb4_bin)
    OR NOT (NEW.title     COLLATE utf8mb4_bin <=> OLD.title     COLLATE utf8mb4_bin)
    OR NOT (NEW.severity  COLLATE utf8mb4_bin <=> OLD.severity  COLLATE utf8mb4_bin);
  DECLARE v_archive_changed BOOLEAN DEFAULT
       NOT (NEW.archived_at <=> OLD.archived_at) OR NOT (NEW.archived_by <=> OLD.archived_by)
    OR NOT (NEW.archive_reason COLLATE utf8mb4_bin <=> OLD.archive_reason COLLATE utf8mb4_bin);

  -- 1. Identity and origin never change.
  IF NOT (NEW.incident_id <=> OLD.incident_id) OR NOT (NEW.reported_by <=> OLD.reported_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB16: incident_id, reported_by and created_at cannot change';
  END IF;
  -- 2. Derived columns belong to the database.
  IF NOT (NEW.resolved_at <=> OLD.resolved_at) OR NOT (NEW.updated_at <=> OLD.updated_at)
     OR NOT (NEW.narrative_version <=> OLD.narrative_version) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: resolved_at, updated_at and narrative_version are maintained by the database';
  END IF;
  -- 3. A no-op UPDATE (e.g. SET status = status) changes nothing, needs no actor and writes no audit row (ADR-6).
  IF NOT (v_status_changed OR v_assignee_changed OR v_descr_changed OR v_archive_changed) THEN
    LEAVE trg;
  END IF;
  -- 4. Archived incidents are read-only.
  IF OLD.archived_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB14: incident is archived and read-only';
  END IF;

  SET v_actor = sdb_actor();
  SET v_role  = sdb_role(v_actor);
  SET v_now   = sdb_now();
  -- Replayed history must move forward in time (catches seed-generator bugs; the live clock always does).
  IF v_now < OLD.updated_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB18: clock is earlier than the last change to this incident';
  END IF;

  -- 5. Closed incidents are frozen except for reopening (a status change) and archiving.
  IF OLD.status = 'closed' AND NOT v_status_changed AND (v_descr_changed OR v_assignee_changed) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB13: incident is closed; reopen it before editing';
  END IF;

  -- 6. Archiving: admin only, closed only, with a reason; stamped with the actor and clock.
  IF v_archive_changed THEN
    IF NEW.archived_at IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB14: archive fields are set only by archive_incident';
    END IF;
    IF v_role <> 'admin' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may archive an incident';
    END IF;
    IF OLD.status <> 'closed' OR v_status_changed OR v_descr_changed OR v_assignee_changed THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB14: only a closed incident can be archived, as a separate change';
    END IF;
    IF TRIM(COALESCE(NEW.archive_reason, '')) = '' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB14: an archive reason is required';
    END IF;
    SET NEW.archived_at = v_now, NEW.archived_by = v_actor;
  END IF;

  -- 7. Assignment: admins assign and reassign (Phase 1 spec section 10); an assigned incident cannot become unassigned.
  IF v_assignee_changed THEN
    IF v_role <> 'admin' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may assign or reassign an incident';
    END IF;
    IF NEW.assigned_to IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB30: an incident cannot be unassigned; reassign it instead';
    END IF;
  END IF;

  -- 8. Status: the transition must be in the state machine and the actor must be allowed to make it.
  IF v_status_changed THEN
    SELECT COUNT(*), MAX(requires_role), COALESCE(MAX(requires_reason), FALSE)
      INTO v_allowed, v_req_role, v_req_reason
      FROM Status_Transitions WHERE from_status = OLD.status AND to_status = NEW.status;
    IF v_allowed = 0 THEN
      SET v_msg = CONCAT('SDB10: transition ', COALESCE(OLD.status, 'NULL'), ' -> ', COALESCE(NEW.status, 'NULL'), ' is not allowed');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
    IF v_req_role = 'admin' AND v_role <> 'admin' THEN
      SET v_msg = CONCAT('SDB11: only an admin may move an incident from ', OLD.status, ' to ', NEW.status);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
    IF NEW.assigned_to IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB15: assign the incident before changing its status';
    END IF;
    IF v_req_role IS NULL AND v_role <> 'admin' AND NOT (NEW.assigned_to <=> v_actor) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only the assignee or an admin may change the status';
    END IF;
    IF v_req_reason AND TRIM(COALESCE(@sentinel_reason, '')) = '' THEN
      SET v_msg = CONCAT('SDB10: a reason is required to move from ', OLD.status, ' to ', NEW.status);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
    -- Closure gate (re-checked here so that no path can bypass close_incident's rule). Locking reads: a concurrent
    -- transaction cannot slip in an unreviewed IOC between this check and the commit.
    IF NEW.status = 'closed' THEN
      SELECT COUNT(*) INTO v_pending FROM Incident_IOC
       WHERE incident_id = OLD.incident_id AND review_status = 'pending' FOR SHARE;
      SELECT COUNT(*) INTO v_undocumented FROM Incident_Asset
       WHERE incident_id = OLD.incident_id AND TRIM(COALESCE(impact_description, '')) = '' FOR SHARE;
      IF v_pending + v_undocumented > 0 THEN
        SET v_msg = CONCAT('SDB12: cannot close: ', v_pending, ' IOC(s) unreviewed, ', v_undocumented, ' asset(s) without impact description');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
      END IF;
    END IF;
    -- resolved_at follows the status: set on resolving, kept on closing, cleared on reopening.
    SET NEW.resolved_at = CASE NEW.status WHEN 'resolved' THEN v_now WHEN 'closed' THEN OLD.resolved_at ELSE NULL END;
  END IF;

  -- 9. Narrative versioning for the vector index (M4 outbox fences on it).
  IF v_narrative_changed THEN
    SET NEW.narrative_version = OLD.narrative_version + 1;
  END IF;
  SET NEW.updated_at = v_now;
END;

-- Exactly one audit row per real status change and per real assignment change.
CREATE TRIGGER trg_incidents_after_update AFTER UPDATE ON Incidents FOR EACH ROW
BEGIN
  DECLARE v_actor INT;
  IF NOT (NEW.status <=> OLD.status) OR NOT (NEW.assigned_to <=> OLD.assigned_to) THEN
    SET v_actor = sdb_actor();
    IF NOT (NEW.status <=> OLD.status) THEN
      INSERT INTO Incident_Status_History
        (incident_id, old_status, new_status, changed_by, actor_name_snapshot, db_account, source, reason, changed_at)
      VALUES
        (NEW.incident_id, OLD.status, NEW.status, v_actor, sdb_user_name(v_actor), USER(), sdb_source(),
         NULLIF(TRIM(LEFT(@sentinel_reason, 500)), ''), NEW.updated_at);
    END IF;
    IF NOT (NEW.assigned_to <=> OLD.assigned_to) THEN
      INSERT INTO Incident_Assignment_History
        (incident_id, old_assignee, new_assignee, changed_by, actor_name_snapshot, db_account, source, reason, changed_at)
      VALUES
        (NEW.incident_id, OLD.assigned_to, NEW.assigned_to, v_actor, sdb_user_name(v_actor), USER(), sdb_source(),
         NULLIF(TRIM(LEFT(@sentinel_reason, 500)), ''), NEW.updated_at);
    END IF;
  END IF;
END;

-- Incidents are archived, never deleted (ADR-4). The FK RESTRICTs (0003) would also stop it; this message is clearer.
CREATE TRIGGER trg_incidents_before_delete BEFORE DELETE ON Incidents FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB19: incidents are archived, never deleted';
END;
