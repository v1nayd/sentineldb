-- SentinelDB — MySQL DDL
CREATE DATABASE IF NOT EXISTS sentineldb;
USE sentineldb;

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

-- Indexes
CREATE INDEX idx_incidents_status_severity ON Incidents(status, severity);
CREATE INDEX idx_iocs_value ON IOCs(ioc_value);
CREATE INDEX idx_incidents_assigned_to ON Incidents(assigned_to);

-- View (MySQL has no FILTER/EXTRACT — rewritten with CASE/TIMESTAMPDIFF)
CREATE VIEW analyst_workload_view AS
SELECT u.user_id, u.name,
       SUM(CASE WHEN i.status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS open_incidents,
       ROUND(AVG(TIMESTAMPDIFF(SECOND, i.created_at, i.resolved_at)) / 3600, 2) AS avg_resolution_hours
FROM Users u
LEFT JOIN Incidents i ON i.assigned_to = u.user_id
WHERE u.role = 'analyst'
GROUP BY u.user_id, u.name;

-- Example ALTER (for the DDL execution deliverable)
ALTER TABLE Assets ADD COLUMN last_audited_at DATETIME;

-- Quick sanity-check inserts (optional, run after tables exist to confirm everything works)
INSERT INTO Users (name, email, password_hash, role) VALUES ('Alice Analyst','alice@sentinel.local','hash1','analyst');
INSERT INTO Users (name, email, password_hash, role) VALUES ('Bob Admin','bob@sentinel.local','hash2','admin');
INSERT INTO Assets (asset_name, asset_type, ip_address, criticality_level, owner_department) VALUES ('WebServer01','server','10.0.0.5',4,'IT');
INSERT INTO Incidents (title, narrative, severity, reported_by, assigned_to) VALUES ('Suspicious login attempt','Multiple failed logins from unfamiliar IP on WebServer01.','high',1,1);
INSERT INTO IOCs (ioc_type, ioc_value, threat_level) VALUES ('ip','203.0.113.5','high');
INSERT INTO Incident_IOC (incident_id, ioc_id, notes) VALUES (1,1,'Source IP of failed login attempts');
INSERT INTO Incident_Asset (incident_id, asset_id, impact_description) VALUES (1,1,'Targeted login endpoint');

-- Sample rows for the remaining four tables, so all 10 have data to show
INSERT INTO Playbooks (name, applicable_incident_type, steps_description, created_by)
VALUES ('Brute-Force Login Response','unauthorized_access','1. Lock affected account. 2. Force password reset. 3. Block source IP at firewall.',2);
INSERT INTO Incident_Playbook (incident_id, playbook_id) VALUES (1,1);
INSERT INTO Notes (incident_id, author_id, content)
VALUES (1,1,'Confirmed the source IP matches a known scanning range from a prior incident.');
-- This UPDATE is what the Section 16 trigger would normally log automatically once triggers
-- are implemented; for now, insert the history row directly to seed the table for viewing.
UPDATE Incidents SET status = 'investigating' WHERE incident_id = 1;
INSERT INTO Incident_Status_History (incident_id, old_status, new_status, changed_by)
VALUES (1,'open','investigating',1);

SELECT * FROM Incidents;
SELECT * FROM analyst_workload_view;
SELECT * FROM Playbooks;
SELECT * FROM Incident_Playbook;
SELECT * FROM Notes;
SELECT * FROM Incident_Status_History;
