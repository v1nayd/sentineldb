-- 0014 — Account procedures (Milestone 3). After this migration the runtime account has NO write grant on Users and
-- cannot even SELECT Users.password_hash (column-level grants, db/grants.sql.tpl). Everything goes through these:
--
--   auth_lookup(email)                         the ONLY way the app reads a password hash (for login)
--   create_user(name, email, hash, role)       admin only; returns the new user_id as a result set
--   set_user_role(user_id, role)               admin only; last-admin rule in the trigger (SDB40)
--   set_user_active(user_id, active)           admin only; deactivation revokes the user's sessions (trigger)
--   set_password_hash(user_id, hash)           the user themself or an admin; revokes the user's sessions (trigger)
--
-- Why the hash is behind a procedure: an SQL-injection bug in ANY other query could otherwise read every password hash
-- (SELECT on Users). auth_lookup takes one exact e-mail and returns one row, so it cannot be used to dump the table.
-- Hashes must look like this application's scrypt format, so a bug can never store a plaintext password (SDB43).
-- Same transaction semantics as 0009: own transaction in autocommit, savepoint inside a caller's transaction.

CREATE FUNCTION sdb_is_password_hash(p_hash VARCHAR(255)) RETURNS BOOLEAN
  DETERMINISTIC NO SQL SQL SECURITY DEFINER
  COMMENT 'TRUE for a $scrypt$ln=..,r=..,p=..$salt$hash string as produced by src/lib/auth/password.ts.'
  RETURN p_hash REGEXP '^[$]scrypt[$]ln=[0-9]{1,2},r=[0-9]{1,2},p=[0-9]{1,2}[$][A-Za-z0-9+/]{16,}={0,2}[$][A-Za-z0-9+/]{32,}={0,2}$';

CREATE PROCEDURE auth_lookup(IN p_email VARCHAR(150))
  READS SQL DATA SQL SECURITY DEFINER
  COMMENT 'Login: account and password hash for one exact e-mail (no actor needed).'
BEGIN
  SELECT user_id, name, email, role, is_active, password_hash FROM Users WHERE email = p_email;
END;

CREATE PROCEDURE create_user(IN p_name VARCHAR(100), IN p_email VARCHAR(150), IN p_password_hash VARCHAR(255), IN p_role VARCHAR(20))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Create an account (admin only). Result set: user_id.'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_actor INT;
  DECLARE v_id INT;
  DECLARE EXIT HANDLER FOR 1213 BEGIN RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_create_user; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_create_user; ELSE START TRANSACTION; END IF;

  SET v_actor = sdb_actor();
  IF sdb_role(v_actor) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may create users';
  END IF;
  IF NOT sdb_is_password_hash(p_password_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB43: password_hash is not a recognised password hash';
  END IF;
  INSERT INTO Users (name, email, password_hash, role) VALUES (p_name, p_email, p_password_hash, p_role);
  SET v_id = LAST_INSERT_ID();

  IF v_in_txn THEN RELEASE SAVEPOINT sp_create_user; ELSE COMMIT; END IF;
  SELECT v_id AS user_id;
END;

CREATE PROCEDURE set_user_role(IN p_user_id INT, IN p_role VARCHAR(20))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Change a role (admin only; the last active admin cannot be demoted).'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_found INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR 1213 BEGIN RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_set_user_role; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_set_user_role; ELSE START TRANSACTION; END IF;

  IF sdb_role(sdb_actor()) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may change a role';
  END IF;
  -- Lock every active admin row first. Correctness of the last-admin rule already comes from the trigger's FOR SHARE
  -- read (0013; mutation-checked: removing BOTH locks lets two concurrent self-deactivations succeed). Taking the locks
  -- here, in one order, makes the second of two concurrent changes wait and then fail cleanly with SDB40 instead of the
  -- two transactions deadlocking on each other's rows.
  SELECT COUNT(*) INTO v_found FROM Users WHERE role = 'admin' AND is_active FOR UPDATE;
  SELECT COUNT(*) INTO v_found FROM Users WHERE user_id = p_user_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB44: user not found';
  END IF;
  UPDATE Users SET role = p_role WHERE user_id = p_user_id;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_set_user_role; ELSE COMMIT; END IF;
END;

CREATE PROCEDURE set_user_active(IN p_user_id INT, IN p_active BOOLEAN)
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Deactivate or reactivate an account (admin only). Deactivation revokes sessions.'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_found INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR 1213 BEGIN RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_set_user_active; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_set_user_active; ELSE START TRANSACTION; END IF;

  IF sdb_role(sdb_actor()) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: only an admin may change account status';
  END IF;
  -- Same lock order as set_user_role (see there).
  SELECT COUNT(*) INTO v_found FROM Users WHERE role = 'admin' AND is_active FOR UPDATE;
  SELECT COUNT(*) INTO v_found FROM Users WHERE user_id = p_user_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB44: user not found';
  END IF;
  UPDATE Users SET is_active = p_active WHERE user_id = p_user_id;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_set_user_active; ELSE COMMIT; END IF;
END;

CREATE PROCEDURE set_password_hash(IN p_user_id INT, IN p_password_hash VARCHAR(255))
  MODIFIES SQL DATA SQL SECURITY DEFINER
  COMMENT 'Store a new password hash (the user themself or an admin). Revokes the user''s sessions.'
BEGIN
  DECLARE v_in_txn BOOLEAN DEFAULT FALSE;
  DECLARE v_actor INT;
  DECLARE v_found INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR 1213 BEGIN RESIGNAL; END;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    IF v_in_txn THEN ROLLBACK TO SAVEPOINT sp_set_password_hash; ELSE ROLLBACK; END IF;
    RESIGNAL;
  END;
  CALL sdb_txn_active(v_in_txn);
  IF v_in_txn THEN SAVEPOINT sp_set_password_hash; ELSE START TRANSACTION; END IF;

  SET v_actor = sdb_actor();
  IF v_actor <> p_user_id AND sdb_role(v_actor) <> 'admin' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB11: users may change only their own password';
  END IF;
  IF NOT sdb_is_password_hash(p_password_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB43: password_hash is not a recognised password hash';
  END IF;
  SELECT COUNT(*) INTO v_found FROM Users WHERE user_id = p_user_id FOR UPDATE;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB44: user not found';
  END IF;
  UPDATE Users SET password_hash = p_password_hash WHERE user_id = p_user_id;

  IF v_in_txn THEN RELEASE SAVEPOINT sp_set_password_hash; ELSE COMMIT; END IF;
END;
