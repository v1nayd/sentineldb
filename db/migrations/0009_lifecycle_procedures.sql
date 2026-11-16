-- 0009 — Lifecycle procedures: the only way the runtime account changes status, assignment or archive state.
--
-- The runtime account has no UPDATE grant on status / assigned_to / resolved_at / archived_*; it has EXECUTE on these
-- four procedures (db/grants.sql.tpl). They are SQL SECURITY DEFINER, so their statements run with the definer's
-- privileges, and every row change still passes through the triggers of 0007/0008. Procedures add what triggers
-- cannot: row locks taken up front (SELECT ... FOR UPDATE), precise error messages, and multi-step work.
--
-- Transaction semantics (one rule for all four):
--   * Called in autocommit mode   -> the procedure runs its own transaction: all of it commits, or none of it.
--   * Called inside a transaction -> it joins the caller's transaction under a savepoint; on error it rolls back to
--     that savepoint (its own partial work only) and re-raises; COMMIT/ROLLBACK stay with the caller.
--   Detecting the mode uses sdb_txn_active (0006), because MySQL has no @@in_transaction.
--   A deadlock (1213) makes InnoDB roll back the whole transaction, savepoints included, so that case only re-raises.
--
-- @sentinel_reason carries the reason into the audit triggers and is always cleared before returning (success or error).

CREATE PROCEDURE transition_incident(IN p_incident_id INT, IN p_to_status VARCHAR(20), IN p_reason VARCHAR(500))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Move an incident along Status_Transitions (not to closed: use close_incident).'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_found INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR 1213 BEGIN SET @sentinel_reason = NULL; RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @sentinel_reason = NULL;
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_transition_incident; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_transition_incident; ELSE START TRANSACTION; END IF;

  DO sdb_actor(); -- fail fast with SDB01/SDB02
  IF p_to_status = 'closed' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB10: use close_incident to close an incident';
  END IF;
  SELECT COUNT(*) INTO v_found FROM Incidents WHERE incident_id = p_incident_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB31: incident not found';
  END IF;
  SET @sentinel_reason = p_reason;
  UPDATE Incidents SET status = p_to_status WHERE incident_id = p_incident_id;
  SET @sentinel_reason = NULL;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_transition_incident; ELSE COMMIT; END IF;
END;

-- Phase 1 spec section 16: "close_incident(incident_id) checks that every linked IOC is marked reviewed and every
-- linked asset has an impact description before allowing the status to move to closed, raising an exception otherwise."
CREATE PROCEDURE close_incident(IN p_incident_id INT, IN p_reason VARCHAR(500))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Close a resolved incident after checking IOC reviews and asset impact descriptions (admin only).'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_actor INT;
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_status VARCHAR(20);
  DECLARE v_pending INT DEFAULT 0;
  DECLARE v_undocumented INT DEFAULT 0;
  DECLARE v_msg VARCHAR(128);
  DECLARE EXIT HANDLER FOR 1213 BEGIN SET @sentinel_reason = NULL; RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @sentinel_reason = NULL;
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_close_incident; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_close_incident; ELSE START TRANSACTION; END IF;

  SET v_actor = sdb_actor();
  -- Lock the incident first: nothing can change its status or evidence until this transaction ends.
  SELECT COUNT(*), MAX(status) INTO v_found, v_status FROM Incidents WHERE incident_id = p_incident_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB31: incident not found';
  END IF;
  IF sdb_role(v_actor) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may close an incident';
  END IF;
  IF v_status <> 'resolved' THEN
    SET v_msg = CONCAT('SDB12: only a resolved incident can be closed (status is ', v_status, ')');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;
  SELECT COUNT(*) INTO v_pending FROM Incident_IOC
   WHERE incident_id = p_incident_id AND review_status = 'pending' FOR SHARE;
  SELECT COUNT(*) INTO v_undocumented FROM Incident_Asset
   WHERE incident_id = p_incident_id AND TRIM(COALESCE(impact_description, '')) = '' FOR SHARE;
  IF v_pending + v_undocumented > 0 THEN
    SET v_msg = CONCAT('SDB12: cannot close: ', v_pending, ' IOC(s) unreviewed, ', v_undocumented, ' asset(s) without impact description');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  SET @sentinel_reason = p_reason;
  UPDATE Incidents SET status = 'closed' WHERE incident_id = p_incident_id; -- the trigger re-checks the same rule
  SET @sentinel_reason = NULL;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_close_incident; ELSE COMMIT; END IF;
END;

-- Phase 1 spec: "transactional multi-step reassignment workflow". Steps, all or nothing:
--   1. lock the incident row (concurrent reassignments serialise; no lost update),
--   2. validate the new assignee,
--   3. change assigned_to            -> trigger writes Incident_Assignment_History,
--   4. write a handover note for the timeline, authored by the acting admin.
CREATE PROCEDURE reassign_incident(IN p_incident_id INT, IN p_new_assignee INT, IN p_reason VARCHAR(500))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Assign or reassign an incident with a handover note (admin only), atomically.'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_actor INT;
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_old INT;
  DECLARE v_new_name VARCHAR(100);
  DECLARE EXIT HANDLER FOR 1213 BEGIN SET @sentinel_reason = NULL; RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @sentinel_reason = NULL;
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_reassign_incident; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_reassign_incident; ELSE START TRANSACTION; END IF;

  SET v_actor = sdb_actor();
  IF TRIM(COALESCE(p_reason, '')) = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB30: a handover reason is required';
  END IF;
  SELECT COUNT(*), MAX(assigned_to) INTO v_found, v_old FROM Incidents WHERE incident_id = p_incident_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB31: incident not found';
  END IF;
  SET v_new_name = sdb_user_name(p_new_assignee);
  IF v_new_name IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB30: the new assignee does not exist';
  END IF;
  IF v_old <=> p_new_assignee THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB30: the incident is already assigned to that user';
  END IF;

  SET @sentinel_reason = p_reason;
  UPDATE Incidents SET assigned_to = p_new_assignee WHERE incident_id = p_incident_id; -- trigger: admin-only, audit row
  INSERT INTO Notes (incident_id, author_id, content)
  VALUES (p_incident_id, v_actor,
          CONCAT(IF(v_old IS NULL, 'Assigned to ', CONCAT('Reassigned from ', sdb_user_name(v_old), ' to ')),
                 v_new_name, ': ', TRIM(p_reason)));
  SET @sentinel_reason = NULL;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_reassign_incident; ELSE COMMIT; END IF;
END;

CREATE PROCEDURE archive_incident(IN p_incident_id INT, IN p_reason VARCHAR(500))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Archive a closed incident (admin only). Archived incidents leave default lists and the vector index.'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_actor INT;
  DECLARE v_found INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR 1213 BEGIN RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_archive_incident; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_archive_incident; ELSE START TRANSACTION; END IF;

  SET v_actor = sdb_actor();
  SELECT COUNT(*) INTO v_found FROM Incidents WHERE incident_id = p_incident_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB31: incident not found';
  END IF;
  -- archived_at / archived_by are re-stamped by the trigger; it also checks admin role, closed status and the reason.
  UPDATE Incidents SET archived_at = sdb_now(), archived_by = v_actor, archive_reason = NULLIF(TRIM(p_reason), '')
   WHERE incident_id = p_incident_id;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_archive_incident; ELSE COMMIT; END IF;
END;
