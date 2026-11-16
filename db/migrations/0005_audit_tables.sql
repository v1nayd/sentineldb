-- 0005 — Audit tables (defects D2, D5, D6; ADR-4).
--
-- Every audit row records WHO (changed_by, FK RESTRICT, plus the name as it was at the time), through WHICH database
-- account (USER(), so direct SQL by a privileged account is visible), from WHICH source ('import' = the migrator/import
-- account that owns the triggers; 'runtime' = any other account, i.e. the application), and WHEN (DB clock).
-- Rows are written only by triggers (0007, 0008) running with their definer's privileges; the runtime account has
-- SELECT only, and 0008 makes the rows immutable even for privileged accounts.
--
-- MySQL cannot authenticate end users: changed_by is what the trusted application asserts (session variable,
-- ADR-7), recorded next to the real database account.

-- 1) Status history: actor becomes mandatory, plus attribution and reason columns.
ALTER TABLE Incident_Status_History
  MODIFY COLUMN changed_by INT NOT NULL,
  MODIFY COLUMN changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN actor_name_snapshot VARCHAR(100) NOT NULL AFTER changed_by,
  ADD COLUMN db_account          VARCHAR(288) NOT NULL AFTER actor_name_snapshot,
  ADD COLUMN source              VARCHAR(10)  NOT NULL AFTER db_account,
  ADD COLUMN reason              VARCHAR(500) NULL     AFTER source;

ALTER TABLE Incident_Status_History
  ADD CONSTRAINT chk_ish_source     CHECK (source IN ('import','runtime')),
  ADD CONSTRAINT chk_ish_new_status CHECK (new_status IN ('open','investigating','contained','resolved','closed')),
  ADD CONSTRAINT chk_ish_old_status CHECK (old_status IS NULL OR old_status IN ('open','investigating','contained','resolved','closed')),
  ADD CONSTRAINT chk_ish_real_change CHECK (NOT (old_status <=> new_status));

-- 2) Assignment history (D6: reassignment used to leave no trace).
CREATE TABLE Incident_Assignment_History (
    assignment_event_id INT AUTO_INCREMENT PRIMARY KEY,
    incident_id         INT NOT NULL,
    old_assignee        INT NULL,
    new_assignee        INT NULL,
    changed_by          INT NOT NULL,
    actor_name_snapshot VARCHAR(100) NOT NULL,
    db_account          VARCHAR(288) NOT NULL,
    source              VARCHAR(10)  NOT NULL,
    reason              VARCHAR(500) NULL,
    changed_at          DATETIME NOT NULL,
    CONSTRAINT fk_iah_incident     FOREIGN KEY (incident_id)  REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
    CONSTRAINT fk_iah_old_assignee FOREIGN KEY (old_assignee) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_iah_new_assignee FOREIGN KEY (new_assignee) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_iah_changed_by   FOREIGN KEY (changed_by)   REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_iah_source      CHECK (source IN ('import','runtime')),
    CONSTRAINT chk_iah_real_change CHECK (NOT (old_assignee <=> new_assignee)),
    INDEX idx_iah_incident_time (incident_id, changed_at)
) ENGINE=InnoDB;

-- 3) IOC review state (D5: the closure rule "every linked IOC is reviewed" had nothing to check).
--    pending = not yet looked at; confirmed = relevant to this incident; dismissed = reviewed, judged a false positive.
--    reviewed_by / reviewed_at are filled by the trigger from the acting user and the DB clock; they cannot be supplied.
ALTER TABLE Incident_IOC
  ADD COLUMN review_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  ADD COLUMN reviewed_by   INT      NULL,
  ADD COLUMN reviewed_at   DATETIME NULL;

ALTER TABLE Incident_IOC
  ADD CONSTRAINT fk_iioc_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES Users(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_iioc_review_status CHECK (review_status IN ('pending','confirmed','dismissed')),
  ADD CONSTRAINT chk_iioc_review_coherent CHECK (
        (review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
     OR (review_status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));

-- 4) Evidence history: linking/unlinking IOCs and assets, and IOC review decisions.
--    Why this is needed: close_incident requires every linked IOC to be reviewed. Without an audit of unlinking, an
--    unreviewed IOC could simply be removed just before closing and nobody would know. Unlinking stays allowed
--    (wrong links happen), but it is recorded, including the review state the link had at the time.
--    Exactly one of ioc_id / asset_id is set (two typed FKs instead of one untyped "evidence_id").
CREATE TABLE Incident_Evidence_History (
    evidence_event_id   INT AUTO_INCREMENT PRIMARY KEY,
    incident_id         INT NOT NULL,
    ioc_id              INT NULL,
    asset_id            INT NULL,
    action              VARCHAR(10)  NOT NULL,
    detail              VARCHAR(500) NULL,
    changed_by          INT NOT NULL,
    actor_name_snapshot VARCHAR(100) NOT NULL,
    db_account          VARCHAR(288) NOT NULL,
    source              VARCHAR(10)  NOT NULL,
    changed_at          DATETIME NOT NULL,
    CONSTRAINT fk_ieh_incident   FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
    CONSTRAINT fk_ieh_ioc        FOREIGN KEY (ioc_id)      REFERENCES IOCs(ioc_id)           ON DELETE RESTRICT,
    CONSTRAINT fk_ieh_asset      FOREIGN KEY (asset_id)    REFERENCES Assets(asset_id)       ON DELETE RESTRICT,
    CONSTRAINT fk_ieh_changed_by FOREIGN KEY (changed_by)  REFERENCES Users(user_id)         ON DELETE RESTRICT,
    CONSTRAINT chk_ieh_one_target CHECK ((ioc_id IS NULL) <> (asset_id IS NULL)),
    CONSTRAINT chk_ieh_action  CHECK (action IN ('linked','unlinked','reviewed')),
    CONSTRAINT chk_ieh_review_is_ioc CHECK (action <> 'reviewed' OR ioc_id IS NOT NULL),
    CONSTRAINT chk_ieh_source  CHECK (source IN ('import','runtime')),
    INDEX idx_ieh_incident_time (incident_id, changed_at)
) ENGINE=InnoDB;
