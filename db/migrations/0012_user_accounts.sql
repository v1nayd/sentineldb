-- 0012 — User accounts, sessions and authentication events (Milestone 3; ADR-4 "users are never deleted").
--
--   Users gains an account state: is_active / deactivated_at / deactivated_by (a leaver is DEACTIVATED, never deleted,
--   because audit rows reference them) and password_changed_at.
--   User_Account_History  audit of account changes (created, role, activation, password, e-mail). Trigger-written.
--   Sessions              server-side login sessions. The cookie holds a random token; only its SHA-256 is stored, so a
--                         copy of this table cannot be replayed as a login.
--   Auth_Events           login successes / failures / blocks / logouts: the audit log of authentication AND the data the
--                         login rate limiter counts (so the limit survives restarts and is shared by every app process).
-- Rules (triggers) are in 0013, procedures in 0014.

ALTER TABLE Users
  ADD COLUMN is_active           BOOLEAN  NOT NULL DEFAULT TRUE AFTER role,
  ADD COLUMN deactivated_at      DATETIME NULL AFTER is_active,
  ADD COLUMN deactivated_by      INT      NULL AFTER deactivated_at,
  ADD COLUMN password_changed_at DATETIME NULL AFTER deactivated_by;

ALTER TABLE Users
  ADD CONSTRAINT fk_users_deactivated_by FOREIGN KEY (deactivated_by) REFERENCES Users(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_users_deactivation CHECK ((is_active AND deactivated_at IS NULL) OR (NOT is_active AND deactivated_at IS NOT NULL));

CREATE TABLE User_Account_History (
    account_event_id    INT AUTO_INCREMENT PRIMARY KEY,
    user_id             INT NOT NULL,
    action              VARCHAR(20)  NOT NULL,
    detail              VARCHAR(300) NULL,
    changed_by          INT NULL,           -- NULL only for bootstrap/import without an acting user (CHECK below)
    actor_name_snapshot VARCHAR(100) NULL,
    db_account          VARCHAR(288) NOT NULL,
    source              VARCHAR(10)  NOT NULL,
    changed_at          DATETIME NOT NULL,
    CONSTRAINT fk_uah_user       FOREIGN KEY (user_id)    REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_uah_changed_by FOREIGN KEY (changed_by) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_uah_action CHECK (action IN ('created','role_changed','deactivated','reactivated','password_changed','email_changed','renamed')),
    CONSTRAINT chk_uah_source CHECK (source IN ('import','runtime')),
    CONSTRAINT chk_uah_actor  CHECK (changed_by IS NOT NULL OR source = 'import'),
    INDEX idx_uah_user_time (user_id, changed_at)
) ENGINE=InnoDB;

CREATE TABLE Sessions (
    token_hash   CHAR(64)     NOT NULL PRIMARY KEY,   -- hex SHA-256 of the cookie token
    user_id      INT          NOT NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- set by trigger: created_at + 8 hours (absolute)
    revoked_at   DATETIME     NULL,
    ip           VARCHAR(45)  NULL,
    user_agent   VARCHAR(200) NULL,
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_sessions_token_hash CHECK (token_hash REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT chk_sessions_times CHECK (expires_at > created_at),
    INDEX idx_sessions_user_active (user_id, revoked_at)
) ENGINE=InnoDB;

CREATE TABLE Auth_Events (
    auth_event_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_type      VARCHAR(20)  NOT NULL,
    email_attempted VARCHAR(150) NULL,
    user_id         INT          NULL,
    ip              VARCHAR(45)  NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- set by trigger to UTC_TIMESTAMP()
    CONSTRAINT fk_auth_events_user FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_auth_events_type CHECK (event_type IN ('login_success','login_failure','login_blocked','logout','password_changed')),
    INDEX idx_auth_events_email_time (email_attempted, created_at),
    INDEX idx_auth_events_ip_time (ip, created_at),
    INDEX idx_auth_events_type_time (event_type, created_at)
) ENGINE=InnoDB;
