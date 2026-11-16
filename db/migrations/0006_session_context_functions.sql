-- 0006 — Session context: who is acting, and what time it is (ADR-2, ADR-7).
--
-- The application passes the end user through the session variable @sentinel_actor (set by withActor() in
-- src/lib/actor.ts, cleared after every unit of work). Triggers and procedures call these helpers instead of reading
-- the variable directly, so "no actor" is always an error, never "unknown, proceed".
--
-- "Import account" = the account that DEFINES these routines (the migrator). Inside a stored routine, CURRENT_USER()
-- is the routine's definer while USER() is the account that actually connected, so comparing the two answers "is the
-- connected session the migrator/import account?" without hard-coding any account name. A procedure called by the
-- runtime account runs as the definer, but USER() still reports the runtime account, so it is NOT an import.
--
-- Only an import session may back-date changes with @sentinel_clock (historical replay in seeds). For every other
-- account the variable is ignored and the database clock (UTC) is used.
--
-- These routines need log_bin_trust_function_creators=1 when binary logging is on (see README / ADR-3).

CREATE FUNCTION sdb_is_import() RETURNS BOOLEAN
  NOT DETERMINISTIC NO SQL SQL SECURITY DEFINER
  COMMENT 'TRUE when the connected account is the account that defined the SentinelDB routines (migrator/import).'
  RETURN SUBSTRING_INDEX(USER(), '@', 1) = SUBSTRING_INDEX(CURRENT_USER(), '@', 1);

CREATE FUNCTION sdb_source() RETURNS VARCHAR(10)
  NOT DETERMINISTIC NO SQL SQL SECURITY DEFINER
  COMMENT 'Audit source label: import or runtime.'
  RETURN IF(sdb_is_import(), 'import', 'runtime');

CREATE FUNCTION sdb_now() RETURNS DATETIME
  NOT DETERMINISTIC NO SQL SQL SECURITY DEFINER
  COMMENT 'Clock for every lifecycle timestamp: @sentinel_clock for import sessions only, otherwise UTC_TIMESTAMP().'
BEGIN
  DECLARE v_clock DATETIME;
  IF @sentinel_clock IS NOT NULL AND sdb_is_import() THEN
    SET v_clock = CAST(@sentinel_clock AS DATETIME);
    IF v_clock IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB03: @sentinel_clock is not a valid DATETIME';
    END IF;
    RETURN v_clock;
  END IF;
  RETURN UTC_TIMESTAMP();
END;

CREATE FUNCTION sdb_actor() RETURNS INT
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  COMMENT 'The acting end user (@sentinel_actor). Raises SDB01/SDB02 instead of returning NULL.'
BEGIN
  DECLARE v_id INT;
  IF @sentinel_actor IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB01: no acting user (@sentinel_actor is not set; use withActor())';
  END IF;
  IF NOT (CAST(@sentinel_actor AS CHAR) REGEXP '^[1-9][0-9]{0,9}$') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: @sentinel_actor must be a user id';
  END IF;
  SELECT user_id INTO v_id FROM Users WHERE user_id = CAST(@sentinel_actor AS UNSIGNED);
  IF v_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SDB02: acting user does not exist';
  END IF;
  RETURN v_id;
END;

CREATE FUNCTION sdb_role(p_user_id INT) RETURNS VARCHAR(20)
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  RETURN (SELECT role FROM Users WHERE user_id = p_user_id);

CREATE FUNCTION sdb_user_name(p_user_id INT) RETURNS VARCHAR(100)
  NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER
  RETURN (SELECT name FROM Users WHERE user_id = p_user_id);

-- MySQL has no @@in_transaction. A savepoint can only be released inside an open transaction, so RELEASE failing with
-- 1305 (savepoint does not exist) means "autocommit, no transaction". Procedures use this to be atomic on their own
-- AND composable inside a caller's transaction (0009).
CREATE PROCEDURE sdb_txn_active(OUT p_active BOOLEAN)
  NOT DETERMINISTIC NO SQL SQL SECURITY DEFINER
  COMMENT 'TRUE if the session already has a transaction open.'
BEGIN
  DECLARE CONTINUE HANDLER FOR 1305 SET p_active = FALSE;
  SET p_active = TRUE;
  SAVEPOINT sdb_txn_probe;
  RELEASE SAVEPOINT sdb_txn_probe;
END;
