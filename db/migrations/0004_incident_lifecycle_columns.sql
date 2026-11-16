-- 0004 — Incident lifecycle state that the database itself keeps coherent (defects D1, D4, D7; ADR-2, ADR-4).
--
-- New columns (none is writable by the runtime account; triggers in 0007 maintain them):
--   updated_at         last real change to the row (DB clock). A no-op UPDATE does not move it.
--   narrative_version  +1 every time the narrative text changes. The M4 sync worker fences vector writes with it.
--   archived_at/_by, archive_reason   soft archive. Incidents are never deleted (ADR-4).
--
-- Row-level CHECK constraints make the impossible states of D4 unrepresentable, whoever writes the row:
--   * resolved_at is set exactly when the status is resolved or closed;
--   * an incident cannot be resolved before it was created;
--   * only a closed incident can be archived, and an archive always names who and why.
--
-- Status_Transitions is the lifecycle as DATA: the trigger in 0007 accepts a status change only if the pair is listed.
-- Keeping it in a table (not hard-coded in the trigger) lets the UI ask "which buttons may I show?" with a SELECT and
-- documents the state machine in one place. The runtime account may read it, never write it.

ALTER TABLE Incidents
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER resolved_at,
  ADD COLUMN narrative_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER updated_at,
  ADD COLUMN archived_at       DATETIME     NULL AFTER narrative_version,
  ADD COLUMN archived_by       INT          NULL AFTER archived_at,
  ADD COLUMN archive_reason    VARCHAR(500) NULL AFTER archived_by;

ALTER TABLE Incidents
  ADD CONSTRAINT fk_incidents_archived_by FOREIGN KEY (archived_by) REFERENCES Users(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_incidents_resolution CHECK ((status IN ('resolved','closed')) = (resolved_at IS NOT NULL)),
  ADD CONSTRAINT chk_incidents_resolved_after_created CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  ADD CONSTRAINT chk_incidents_archive CHECK (
        (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
     OR (archived_at IS NOT NULL AND archived_by IS NOT NULL AND archive_reason IS NOT NULL AND status = 'closed')),
  ADD CONSTRAINT chk_incidents_narrative_version CHECK (narrative_version >= 1);

CREATE TABLE Status_Transitions (
    from_status     VARCHAR(20) NOT NULL,
    to_status       VARCHAR(20) NOT NULL,
    requires_role   VARCHAR(20) NULL,      -- NULL: the assignee or an admin; 'admin': admins only
    requires_reason BOOLEAN     NOT NULL DEFAULT FALSE,
    description     VARCHAR(200) NOT NULL,
    PRIMARY KEY (from_status, to_status),
    CONSTRAINT chk_st_from CHECK (from_status IN ('open','investigating','contained','resolved','closed')),
    CONSTRAINT chk_st_to   CHECK (to_status   IN ('open','investigating','contained','resolved','closed')),
    CONSTRAINT chk_st_role CHECK (requires_role IS NULL OR requires_role = 'admin'),
    CONSTRAINT chk_st_distinct CHECK (from_status <> to_status)
) ENGINE=InnoDB COMMENT='reference: lifecycle state machine, owned by migrations';

-- The lifecycle. Anything not listed (e.g. open -> closed, the D1 probe) is rejected.
-- Roles follow the Phase 1 spec section 10: managers/admins close, reopen and reassign; analysts work their own incidents.
INSERT INTO Status_Transitions (from_status, to_status, requires_role, requires_reason, description) VALUES
  ('open',          'investigating', NULL,    FALSE, 'Start investigation'),
  ('investigating', 'contained',     NULL,    FALSE, 'Threat contained'),
  ('investigating', 'resolved',      NULL,    FALSE, 'Resolved without a separate containment step'),
  ('contained',     'investigating', NULL,    TRUE,  'Containment failed or new activity found'),
  ('contained',     'resolved',      NULL,    FALSE, 'Eradicated and recovered'),
  ('resolved',      'closed',        'admin', FALSE, 'Close after review (close_incident checks the evidence)'),
  ('resolved',      'investigating', 'admin', TRUE,  'Reopen a resolved incident'),
  ('closed',        'investigating', 'admin', TRUE,  'Reopen a closed incident');
