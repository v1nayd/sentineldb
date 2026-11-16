-- 0001 — Baseline: the schema exactly as submitted in Phase 1 (phase1/sentineldb-ddl-mysql.sql).
--
-- Differences from the submitted file, all intentional and non-structural:
--   * No CREATE DATABASE / USE — the migration runner connects to the target schema.
--   * No sanity-check INSERTs (they contain fake password hashes and a manually inserted history row
--     that would duplicate rows once the audit trigger exists). Phase 2 seed data lives in db/seed/.
--   * The Phase 1 "example ALTER" (Assets.last_audited_at) is kept: it is part of the submitted schema.
--
-- tests/baseline-equivalence.test.ts proves this file produces the same catalog as the Phase 1 file.
-- Known weaknesses of this baseline are fixed by LATER migrations, never by editing this file.

CREATE TABLE Users (
    user_id       INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(20) NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_users_role CHECK (role IN ('analyst','admin'))
) ENGINE=InnoDB;

CREATE TABLE Assets (
    asset_id          INT AUTO_INCREMENT PRIMARY KEY,
    asset_name        VARCHAR(150) NOT NULL,
    asset_type        VARCHAR(30) NOT NULL,
    ip_address        VARCHAR(45),
    criticality_level TINYINT NOT NULL,
    owner_department  VARCHAR(100),
    CONSTRAINT chk_assets_type CHECK (asset_type IN ('server','workstation','network_device','application')),
    CONSTRAINT chk_assets_criticality CHECK (criticality_level BETWEEN 1 AND 5)
) ENGINE=InnoDB;

CREATE TABLE Incidents (
    incident_id   INT AUTO_INCREMENT PRIMARY KEY,
    title         VARCHAR(200) NOT NULL,
    narrative     TEXT NOT NULL,
    severity      VARCHAR(10) NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'open',
    reported_by   INT NOT NULL,
    assigned_to   INT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at   DATETIME,
    CONSTRAINT chk_incidents_severity CHECK (severity IN ('low','medium','high','critical')),
    CONSTRAINT chk_incidents_status CHECK (status IN ('open','investigating','contained','resolved','closed')),
    CONSTRAINT fk_incidents_reported_by FOREIGN KEY (reported_by) REFERENCES Users(user_id) ON DELETE RESTRICT,
    CONSTRAINT fk_incidents_assigned_to FOREIGN KEY (assigned_to) REFERENCES Users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IOCs (
    ioc_id       INT AUTO_INCREMENT PRIMARY KEY,
    ioc_type     VARCHAR(20) NOT NULL,
    ioc_value    VARCHAR(255) NOT NULL,
    first_seen   DATETIME DEFAULT CURRENT_TIMESTAMP,
    threat_level VARCHAR(10),
    CONSTRAINT chk_iocs_type CHECK (ioc_type IN ('ip','domain','file_hash','email','url')),
    CONSTRAINT chk_iocs_threat CHECK (threat_level IN ('low','medium','high','critical')),
    CONSTRAINT uq_iocs_type_value UNIQUE (ioc_type, ioc_value)
) ENGINE=InnoDB;

CREATE TABLE Incident_IOC (
    incident_id INT,
    ioc_id      INT,
    notes       TEXT,
    PRIMARY KEY (incident_id, ioc_id),
    CONSTRAINT fk_iioc_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_iioc_ioc FOREIGN KEY (ioc_id) REFERENCES IOCs(ioc_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE Incident_Asset (
    incident_id         INT,
    asset_id            INT,
    impact_description  TEXT,
    PRIMARY KEY (incident_id, asset_id),
    CONSTRAINT fk_iasset_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_iasset_asset FOREIGN KEY (asset_id) REFERENCES Assets(asset_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE Playbooks (
    playbook_id               INT AUTO_INCREMENT PRIMARY KEY,
    name                      VARCHAR(150) UNIQUE NOT NULL,
    applicable_incident_type  VARCHAR(50),
    steps_description         TEXT,
    created_by                INT,
    CONSTRAINT fk_playbooks_created_by FOREIGN KEY (created_by) REFERENCES Users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE Incident_Playbook (
    incident_id INT,
    playbook_id INT,
    applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (incident_id, playbook_id),
    CONSTRAINT fk_ipb_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_ipb_playbook FOREIGN KEY (playbook_id) REFERENCES Playbooks(playbook_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE Incident_Status_History (
    history_id  INT AUTO_INCREMENT PRIMARY KEY,
    incident_id INT NOT NULL,
    old_status  VARCHAR(20),
    new_status  VARCHAR(20) NOT NULL,
    changed_by  INT,
    changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ish_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_ish_changed_by FOREIGN KEY (changed_by) REFERENCES Users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE Notes (
    note_id     INT AUTO_INCREMENT PRIMARY KEY,
    incident_id INT NOT NULL,
    author_id   INT NOT NULL,
    content     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notes_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_notes_author FOREIGN KEY (author_id) REFERENCES Users(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Indexes (as submitted)
CREATE INDEX idx_incidents_status_severity ON Incidents(status, severity);
CREATE INDEX idx_iocs_value ON IOCs(ioc_value);
CREATE INDEX idx_incidents_assigned_to ON Incidents(assigned_to);

CREATE VIEW analyst_workload_view AS
SELECT u.user_id, u.name,
       SUM(CASE WHEN i.status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS open_incidents,
       ROUND(AVG(TIMESTAMPDIFF(SECOND, i.created_at, i.resolved_at)) / 3600, 2) AS avg_resolution_hours
FROM Users u
LEFT JOIN Incidents i ON i.assigned_to = u.user_id
WHERE u.role = 'analyst'
GROUP BY u.user_id, u.name;

-- The Phase 1 "example ALTER"
ALTER TABLE Assets ADD COLUMN last_audited_at DATETIME;
