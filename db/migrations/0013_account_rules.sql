-- 0013 — Account rules, enforced by triggers like the incident lifecycle (Milestone 3).
--
--   * A DEACTIVATED user can no longer act: sdb_actor() rejects them (SDB02), so every lifecycle write fails even if a
--     session were somehow still valid; deactivation also revokes their sessions; nobody can be assigned to them.
--   * Role, activation and e-mail changes need an admin actor; name and password changes need the user themself or an
--     admin. The import (migrator) account may act without an actor for bootstrap and dev tooling (source = 'import').
--   * The last ACTIVE admin can be neither demoted nor deactivated (SDB40), otherwise nobody could administer the system.
--     The check reads the admin rows FOR SHARE, so two admins demoting each other concurrently cannot both succeed.
--   * A password change revokes every session of that user (log out everywhere).
--   * Users are never deleted (SDB41); account history and auth events are immutable (SDB20).
--   * Session timestamps come from the database clock (never back-dated, not even by the import account).

DROP FUNCTION sdb_actor;
CREATE FUNCTION sdb_actor() RETURNS INT
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  COMMENT 'The acting end user (@sentinel_actor). Raises SDB01/SDB02 instead of returning NULL; rejects deactivated users.'
BEGIN
  DECLARE v_id INT;
  DECLARE v_active BOOLEAN;
  IF @sentinel_actor IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB01: no acting user (@sentinel_actor is not set; use withActor())';
  END IF;
  IF NOT (CAST(@sentinel_actor AS CHAR) REGEXP '^[1-9][0-9]{0,9}$') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: @sentinel_actor must be a user id';
  END IF;
  SELECT user_id, is_active INTO v_id, v_active FROM Users WHERE user_id = CAST(@sentinel_actor AS UNSIGNED);
  IF v_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: acting user does not exist';
  END IF;
  IF NOT v_active THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: acting user is deactivated';
  END IF;
  RETURN v_id;
END;

-- Optional actor: the import account may work without one (bootstrap, dev tooling); everyone else must have one.
CREATE FUNCTION sdb_actor_or_import() RETURNS INT
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  COMMENT 'sdb_actor(), except that an import session without @sentinel_actor yields NULL instead of an error.'
  RETURN IF(@sentinel_actor IS NULL AND sdb_is_import(), NULL, sdb_actor());

-- ---------------------------------------------------------------- Users
CREATE TRIGGER trg_users_before_insert BEFORE INSERT ON Users FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor_or_import();
  IF v_actor IS NOT NULL AND sdb_role(v_actor) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may create users';
  END IF;
  IF NOT (NEW.is_active <=> TRUE) OR NEW.deactivated_at IS NOT NULL OR NEW.deactivated_by IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: a new user starts active; deactivate with set_user_active';
  END IF;
  -- Runtime-created users get the DB clock; the import account may supply a historical created_at (seeds).
  IF NOT sdb_is_import() OR NEW.created_at IS NULL THEN SET NEW.created_at = sdb_now(); END IF;
  SET NEW.password_changed_at = NEW.created_at;
END;

CREATE TRIGGER trg_users_after_insert AFTER INSERT ON Users FOR EACH ROW
BEGIN
  DECLARE v_actor INT DEFAULT sdb_actor_or_import();
  INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
  VALUES (NEW.user_id, 'created', CONCAT('role ', NEW.role), v_actor, sdb_user_name(v_actor), USER(), sdb_source(), NEW.created_at);
END;

CREATE TRIGGER trg_users_before_update BEFORE UPDATE ON Users FOR EACH ROW
trg: BEGIN
  DECLARE v_actor INT;
  DECLARE v_actor_role VARCHAR(20);
  DECLARE v_other_admins INT DEFAULT 0;
  DECLARE v_role_changed   BOOLEAN DEFAULT NOT (NEW.role COLLATE utf8mb4_bin <=> OLD.role COLLATE utf8mb4_bin);
  DECLARE v_active_changed BOOLEAN DEFAULT NOT (NEW.is_active <=> OLD.is_active);
  DECLARE v_pw_changed     BOOLEAN DEFAULT NOT (NEW.password_hash COLLATE utf8mb4_bin <=> OLD.password_hash COLLATE utf8mb4_bin);
  DECLARE v_email_changed  BOOLEAN DEFAULT NOT (NEW.email COLLATE utf8mb4_bin <=> OLD.email COLLATE utf8mb4_bin);
  DECLARE v_name_changed   BOOLEAN DEFAULT NOT (NEW.name COLLATE utf8mb4_bin <=> OLD.name COLLATE utf8mb4_bin);

  IF NOT (NEW.user_id <=> OLD.user_id) OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB16: user_id and created_at cannot change';
  END IF;
  IF NOT (NEW.deactivated_at <=> OLD.deactivated_at) OR NOT (NEW.deactivated_by <=> OLD.deactivated_by)
     OR NOT (NEW.password_changed_at <=> OLD.password_changed_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: deactivated_at/_by and password_changed_at are maintained by the database';
  END IF;
  IF NOT (v_role_changed OR v_active_changed OR v_pw_changed OR v_email_changed OR v_name_changed) THEN
    LEAVE trg;
  END IF;

  SET v_actor = sdb_actor_or_import();
  IF v_actor IS NOT NULL THEN
    SET v_actor_role = sdb_role(v_actor);
    IF (v_role_changed OR v_active_changed OR v_email_changed) AND v_actor_role <> 'admin' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may change a role, account status or e-mail';
    END IF;
    IF (v_pw_changed OR v_name_changed) AND v_actor_role <> 'admin' AND v_actor <> OLD.user_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: users may change only their own name and password';
    END IF;
  END IF;

  -- Never leave the system without an active administrator (applies to every account, import included).
  IF OLD.role = 'admin' AND OLD.is_active AND (NEW.role <> 'admin' OR NOT NEW.is_active) THEN
    SELECT COUNT(*) INTO v_other_admins FROM Users
     WHERE role = 'admin' AND is_active AND user_id <> OLD.user_id FOR SHARE;
    IF v_other_admins = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB40: the last active admin cannot be demoted or deactivated';
    END IF;
  END IF;

  IF v_active_changed THEN
    IF NEW.is_active THEN
      SET NEW.deactivated_at = NULL, NEW.deactivated_by = NULL;
    ELSE
      SET NEW.deactivated_at = sdb_now(), NEW.deactivated_by = v_actor;
    END IF;
  END IF;
  IF v_pw_changed THEN SET NEW.password_changed_at = sdb_now(); END IF;
END;

CREATE TRIGGER trg_users_after_update AFTER UPDATE ON Users FOR EACH ROW
BEGIN
  DECLARE v_actor INT;
  DECLARE v_at DATETIME;
  IF NOT (NEW.role COLLATE utf8mb4_bin <=> OLD.role COLLATE utf8mb4_bin) OR NOT (NEW.is_active <=> OLD.is_active)
     OR NOT (NEW.password_hash COLLATE utf8mb4_bin <=> OLD.password_hash COLLATE utf8mb4_bin)
     OR NOT (NEW.email COLLATE utf8mb4_bin <=> OLD.email COLLATE utf8mb4_bin)
     OR NOT (NEW.name COLLATE utf8mb4_bin <=> OLD.name COLLATE utf8mb4_bin) THEN
    -- The BEFORE trigger already validated the actor. Do NOT re-validate here: when an admin deactivates their own
    -- account, their row is already inactive at this point and sdb_actor() would (wrongly) reject them.
    SET v_actor = CAST(@sentinel_actor AS UNSIGNED);
    SET v_at = sdb_now();
    IF NOT (NEW.role COLLATE utf8mb4_bin <=> OLD.role COLLATE utf8mb4_bin) THEN
      INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
      VALUES (NEW.user_id, 'role_changed', CONCAT(OLD.role, ' -> ', NEW.role), v_actor, sdb_user_name(v_actor), USER(), sdb_source(), v_at);
    END IF;
    IF NOT (NEW.is_active <=> OLD.is_active) THEN
      INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
      VALUES (NEW.user_id, IF(NEW.is_active, 'reactivated', 'deactivated'), NULL, v_actor, sdb_user_name(v_actor), USER(), sdb_source(), v_at);
    END IF;
    IF NOT (NEW.password_hash COLLATE utf8mb4_bin <=> OLD.password_hash COLLATE utf8mb4_bin) THEN
      INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
      VALUES (NEW.user_id, 'password_changed', IF(v_actor <=> NEW.user_id, 'by the user', 'reset by another account'),
              v_actor, sdb_user_name(v_actor), USER(), sdb_source(), v_at);
    END IF;
    IF NOT (NEW.email COLLATE utf8mb4_bin <=> OLD.email COLLATE utf8mb4_bin) THEN
      INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
      VALUES (NEW.user_id, 'email_changed', LEFT(CONCAT(OLD.email, ' -> ', NEW.email), 300), v_actor, sdb_user_name(v_actor), USER(), sdb_source(), v_at);
    END IF;
    IF NOT (NEW.name COLLATE utf8mb4_bin <=> OLD.name COLLATE utf8mb4_bin) THEN
      INSERT INTO User_Account_History (user_id, action, detail, changed_by, actor_name_snapshot, db_account, source, changed_at)
      VALUES (NEW.user_id, 'renamed', LEFT(CONCAT(OLD.name, ' -> ', NEW.name), 300), v_actor, sdb_user_name(v_actor), USER(), sdb_source(), v_at);
    END IF;
    -- Deactivation and password changes end every session of that user ("log out everywhere").
    IF (OLD.is_active AND NOT NEW.is_active) OR NOT (NEW.password_hash COLLATE utf8mb4_bin <=> OLD.password_hash COLLATE utf8mb4_bin) THEN
      UPDATE Sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = NEW.user_id AND revoked_at IS NULL;
    END IF;
  END IF;
END;

CREATE TRIGGER trg_users_before_delete BEFORE DELETE ON Users FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB41: users are deactivated, never deleted';

-- ---------------------------------------------------------------- Incidents: no assignment to a deactivated user
CREATE TRIGGER trg_incidents_assignee_active BEFORE UPDATE ON Incidents FOR EACH ROW FOLLOWS trg_incidents_before_update
BEGIN
  IF NOT (NEW.assigned_to <=> OLD.assigned_to) AND NEW.assigned_to IS NOT NULL
     AND NOT (SELECT is_active FROM Users WHERE user_id = NEW.assigned_to) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB42: cannot assign an incident to a deactivated user';
  END IF;
END;

-- ---------------------------------------------------------------- Sessions
CREATE TRIGGER trg_sessions_before_insert BEFORE INSERT ON Sessions FOR EACH ROW
BEGIN
  IF NOT (SELECT is_active FROM Users WHERE user_id = NEW.user_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: cannot open a session for a deactivated user';
  END IF;
  SET NEW.created_at = UTC_TIMESTAMP(), NEW.last_seen_at = UTC_TIMESTAMP(),
      NEW.expires_at = UTC_TIMESTAMP() + INTERVAL 8 HOUR, NEW.revoked_at = NULL;
END;

CREATE TRIGGER trg_sessions_before_update BEFORE UPDATE ON Sessions FOR EACH ROW
BEGIN
  IF NOT (NEW.token_hash <=> OLD.token_hash) OR NOT (NEW.user_id <=> OLD.user_id) OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB16: a session cannot be re-pointed';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NOT (NEW.revoked_at <=> OLD.revoked_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB17: a revoked session stays revoked';
  END IF;
END;

-- ---------------------------------------------------------------- Auth_Events: DB clock, append-only
CREATE TRIGGER trg_auth_events_before_insert BEFORE INSERT ON Auth_Events FOR EACH ROW
  SET NEW.created_at = UTC_TIMESTAMP();
CREATE TRIGGER trg_auth_events_before_update BEFORE UPDATE ON Auth_Events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: authentication events are append-only';
CREATE TRIGGER trg_auth_events_before_delete BEFORE DELETE ON Auth_Events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: authentication events are append-only';

CREATE TRIGGER trg_uah_before_update BEFORE UPDATE ON User_Account_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
CREATE TRIGGER trg_uah_before_delete BEFORE DELETE ON User_Account_History FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB20: audit history is immutable';
