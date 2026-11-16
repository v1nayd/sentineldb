-- 0008 — Evidence links, IOC review, notes, and immutable audit tables (D2, D5; ADR-3 "unaudited unlink" follow-up).
--
--   * Linking / unlinking an IOC or asset requires an acting user, is refused on closed or archived incidents, and is
--     written to Incident_Evidence_History (unlinks record the review state the link had).
--   * IOC review (Incident_IOC.review_status) may be changed by the assignee or an admin; reviewed_by / reviewed_at
--     are stamped by the database from the actor and clock, so a review cannot be attributed to someone else.
--   * Notes: author must be the acting user; created_at is the DB clock; notes are append-only for EVERY account.
--   * Audit tables reject UPDATE and DELETE for every account, including the migrator. (A privileged account can of
--     course still DROP the trigger; the migrator is trusted with DDL. These triggers stop accidents and app bugs.)
--
-- Locking: the parent incident is read FOR SHARE, so a link inserted concurrently with close_incident (which holds the
-- incident row FOR UPDATE) waits for the close to commit and is then refused, instead of attaching an unreviewed IOC
-- to an incident that has just been closed (tests/procedures.test.ts reproduces the race).

CREATE PROCEDURE sdb_assert_incident_writable(IN p_incident_id INT, IN p_allow_closed BOOLEAN)
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  COMMENT 'Raises SDB31/SDB13/SDB14 unless the incident exists and its evidence may still change.'
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_archived DATETIME;
  DECLARE v_found INT DEFAULT 0;
  SELECT COUNT(*), MAX(status), MAX(archived_at) INTO v_found, v_status, v_archived
    FROM Incidents WHERE incident_id = p_incident_id FOR SHARE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB31: incident not found';
  END IF;
  IF v_archived IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB14: incident is archived and read-only';
  END IF;
  IF v_status = 'closed' AND NOT p_allow_closed THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB13: incident is closed; its evidence can no longer change';
  END IF;
END;

-- ---------------------------------------------------------------- Incident_IOC
CREATE TRIGGER trg_incident_ioc_before_insert BEFORE INSERT ON Incident_IOC FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  CALL sdb_assert_incident_writable(NEW.incident_id, FALSE);
  IF NOT (NEW.review_status <=> 'pending') OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: a new IOC link starts pending; review it with an UPDATE of review_status';
  END IF;
END;

CREATE TRIGGER trg_incident_ioc_after_insert AFTER INSERT ON Incident_IOC FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  INSERT INTO Incident_Evidence_History
    (incident_id, ioc_id, asset_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
  VALUES (NEW.incident_id, NEW.ioc_id, NULL, 'linked', NULL, v_actor, sdb_user_name(v_actor), USER(), sdb_source(), sdb_now());
END;

CREATE TRIGGER trg_incident_ioc_before_update BEFORE UPDATE ON Incident_IOC FOR EACH ROW
trg: BEGIN
  DECLARE v_actor INT;
  DECLARE v_assignee INT;
  DECLARE v_review_changed BOOLEAN DEFAULT NOT (NEW.review_status <=> OLD.review_status);
  IF NOT (NEW.incident_id <=> OLD.incident_id) OR NOT (NEW.ioc_id <=> OLD.ioc_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB16: a link cannot be re-pointed; unlink and link instead';
  END IF;
  IF NOT (NEW.reviewed_by <=> OLD.reviewed_by) OR NOT (NEW.reviewed_at <=> OLD.reviewed_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: reviewed_by and reviewed_at are set by the database';
  END IF;
  IF NOT v_review_changed AND (NEW.notes COLLATE utf8mb4_bin <=> OLD.notes COLLATE utf8mb4_bin) THEN
    LEAVE trg; -- no-op
  END IF;
  SET v_actor = sdb_actor();
  CALL sdb_assert_incident_writable(OLD.incident_id, FALSE);
  IF v_review_changed THEN
    SELECT assigned_to INTO v_assignee FROM Incidents WHERE incident_id = OLD.incident_id;
    IF sdb_role(v_actor) <> 'admin' AND NOT (v_assignee <=> v_actor) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only the assignee or an admin may review an IOC';
    END IF;
    IF NEW.review_status = 'pending' THEN
      SET NEW.reviewed_by = NULL, NEW.reviewed_at = NULL;
    ELSE
      SET NEW.reviewed_by = v_actor, NEW.reviewed_at = sdb_now();
    END IF;
  END IF;
END;

CREATE TRIGGER trg_incident_ioc_after_update AFTER UPDATE ON Incident_IOC FOR EACH ROW
BEGIN
  DECLARE v_actor INT;
  IF NOT (NEW.review_status <=> OLD.review_status) THEN
    SET v_actor = sdb_actor();
    INSERT INTO Incident_Evidence_History
      (incident_id, ioc_id, asset_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
    VALUES (NEW.incident_id, NEW.ioc_id, NULL, 'reviewed', CONCAT(OLD.review_status, ' -> ', NEW.review_status),
            v_actor, sdb_user_name(v_actor), USER(), sdb_source(), sdb_now());
  END IF;
END;

CREATE TRIGGER trg_incident_ioc_before_delete BEFORE DELETE ON Incident_IOC FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  CALL sdb_assert_incident_writable(OLD.incident_id, FALSE);
END;

CREATE TRIGGER trg_incident_ioc_after_delete AFTER DELETE ON Incident_IOC FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  INSERT INTO Incident_Evidence_History
    (incident_id, ioc_id, asset_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
  VALUES (OLD.incident_id, OLD.ioc_id, NULL, 'unlinked', CONCAT('review state at unlink: ', OLD.review_status),
          v_actor, sdb_user_name(v_actor), USER(), sdb_source(), sdb_now());
END;

-- ---------------------------------------------------------------- Incident_Asset
CREATE TRIGGER trg_incident_asset_before_insert BEFORE INSERT ON Incident_Asset FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  CALL sdb_assert_incident_writable(NEW.incident_id, FALSE);
END;

CREATE TRIGGER trg_incident_asset_after_insert AFTER INSERT ON Incident_Asset FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  INSERT INTO Incident_Evidence_History
    (incident_id, ioc_id, asset_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
  VALUES (NEW.incident_id, NULL, NEW.asset_id, 'linked', NULL, v_actor, sdb_user_name(v_actor), USER(), sdb_source(), sdb_now());
END;

CREATE TRIGGER trg_incident_asset_before_update BEFORE UPDATE ON Incident_Asset FOR EACH ROW
trg: BEGIN
  DECLARE v_actor INT;
  IF NOT (NEW.incident_id <=> OLD.incident_id) OR NOT (NEW.asset_id <=> OLD.asset_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB16: a link cannot be re-pointed; unlink and link instead';
  END IF;
  IF NEW.impact_description COLLATE utf8mb4_bin <=> OLD.impact_description COLLATE utf8mb4_bin THEN
    LEAVE trg; -- no-op
  END IF;
  SET v_actor = sdb_actor();
  CALL sdb_assert_incident_writable(OLD.incident_id, FALSE);
END;

CREATE TRIGGER trg_incident_asset_before_delete BEFORE DELETE ON Incident_Asset FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  CALL sdb_assert_incident_writable(OLD.incident_id, FALSE);
END;

CREATE TRIGGER trg_incident_asset_after_delete AFTER DELETE ON Incident_Asset FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  INSERT INTO Incident_Evidence_History
    (incident_id, ioc_id, asset_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
  VALUES (OLD.incident_id, NULL, OLD.asset_id, 'unlinked', NULL, v_actor, sdb_user_name(v_actor), USER(), sdb_source(), sdb_now());
END;

-- ---------------------------------------------------------------- Notes
CREATE TRIGGER trg_notes_before_insert BEFORE INSERT ON Notes FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor();
  IF NOT (NEW.author_id <=> v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB21: a note''s author must be the acting user';
  END IF;
  CALL sdb_assert_incident_writable(NEW.incident_id, TRUE); -- post-incident notes on closed incidents are allowed
  SET NEW.created_at = sdb_now();
END;

CREATE TRIGGER trg_notes_before_update BEFORE UPDATE ON Notes FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: notes are append-only';
CREATE TRIGGER trg_notes_before_delete BEFORE DELETE ON Notes FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: notes are append-only';

-- ---------------------------------------------------------------- audit tables are immutable
CREATE TRIGGER trg_ish_before_update BEFORE UPDATE ON Incident_Status_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_ish_before_delete BEFORE DELETE ON Incident_Status_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_iah_before_update BEFORE UPDATE ON Incident_Assignment_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_iah_before_delete BEFORE DELETE ON Incident_Assignment_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_ieh_before_update BEFORE UPDATE ON Incident_Evidence_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_ieh_before_delete BEFORE DELETE ON Incident_Evidence_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
