-- 0015 — Embedding outbox and lexical index (Milestone 4; ADR-5 "Designed (M4)", now implemented).
--
-- Problem: an incident lives in MySQL, its vector in Qdrant, and there is no transaction spanning both. Writing to
-- Qdrant from the request would lose the vector whenever Qdrant is down or the process dies between the two writes.
--
-- Transactional outbox: the change and the job that propagates it are written in the SAME MySQL transaction, by
-- triggers, so every path (API, procedures, seeds, direct SQL) enqueues exactly what it changed:
--   * a new incident                      -> 'upsert' job for narrative_version 1
--   * a narrative edit (version bumped)   -> 'upsert' job for the new version; older pending upserts are superseded
--   * archiving                           -> 'delete' job (archived incidents leave the index); pending upserts superseded
-- A worker (src/lib/sync.ts) claims jobs with FOR UPDATE SKIP LOCKED, embeds, writes Qdrant, and marks the job done
-- only if the incident is still at that version. Failures retry with backoff; reconcile() remains the backstop.
--
-- incident_sync_view states, per incident, whether its CURRENT narrative has been indexed according to the outbox
-- (synced / pending / failed / missing / archived). It is MySQL's bookkeeping; reconcile() checks Qdrant itself.
--
-- FULLTEXT(title, narrative) serves the keyword baseline of the evaluation and the lexical fallback when Qdrant or the
-- embedding model is unavailable (results are then labelled "lexical fallback", never presented as semantic).

CREATE TABLE Embedding_Jobs (
    job_id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    incident_id       INT          NOT NULL,
    narrative_version INT          NOT NULL,
    action            VARCHAR(10)  NOT NULL,
    status            VARCHAR(12)  NOT NULL DEFAULT 'pending',
    attempts          INT          NOT NULL DEFAULT 0,
    available_at      DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
    locked_at         DATETIME     NULL,
    locked_by         VARCHAR(64)  NULL,
    last_error        VARCHAR(500) NULL,
    created_at        DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
    finished_at       DATETIME     NULL,
    CONSTRAINT fk_jobs_incident FOREIGN KEY (incident_id) REFERENCES Incidents(incident_id) ON DELETE RESTRICT,
    CONSTRAINT uq_jobs_version_action UNIQUE (incident_id, narrative_version, action),
    CONSTRAINT chk_jobs_action   CHECK (action IN ('upsert', 'delete')),
    CONSTRAINT chk_jobs_status   CHECK (status IN ('pending', 'running', 'done', 'failed', 'superseded')),
    CONSTRAINT chk_jobs_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_jobs_version  CHECK (narrative_version >= 1),
    CONSTRAINT chk_jobs_lock     CHECK ((status = 'running') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
    CONSTRAINT chk_jobs_finished CHECK ((status IN ('done', 'failed', 'superseded')) = (finished_at IS NOT NULL))
) ENGINE=InnoDB COMMENT='Outbox: MySQL -> Qdrant propagation jobs, written by triggers in the changing transaction';

-- The worker's claim query: WHERE status = 'pending' AND available_at <= now ORDER BY job_id.
CREATE INDEX idx_jobs_claim ON Embedding_Jobs (status, available_at, job_id);

CREATE TRIGGER trg_incidents_outbox_after_insert AFTER INSERT ON Incidents FOR EACH ROW FOLLOWS trg_incidents_after_insert
  INSERT INTO Embedding_Jobs (incident_id, narrative_version, action) VALUES (NEW.incident_id, NEW.narrative_version, 'upsert');

CREATE TRIGGER trg_incidents_outbox_after_update AFTER UPDATE ON Incidents FOR EACH ROW FOLLOWS trg_incidents_after_update
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    UPDATE Embedding_Jobs SET status = 'superseded', finished_at = UTC_TIMESTAMP(), last_error = 'incident archived'
     WHERE incident_id = NEW.incident_id AND action = 'upsert' AND status = 'pending';
    INSERT INTO Embedding_Jobs (incident_id, narrative_version, action) VALUES (NEW.incident_id, NEW.narrative_version, 'delete');
  ELSEIF NEW.narrative_version <> OLD.narrative_version THEN
    UPDATE Embedding_Jobs SET status = 'superseded', finished_at = UTC_TIMESTAMP(), last_error = 'newer narrative version queued'
     WHERE incident_id = NEW.incident_id AND action = 'upsert' AND status = 'pending' AND narrative_version < NEW.narrative_version;
    INSERT INTO Embedding_Jobs (incident_id, narrative_version, action) VALUES (NEW.incident_id, NEW.narrative_version, 'upsert');
  END IF;
END;

CREATE VIEW incident_sync_view AS
SELECT i.incident_id,
       i.narrative_version,
       CASE WHEN i.archived_at IS NOT NULL      THEN 'archived'
            WHEN j.job_id IS NULL               THEN 'missing'
            WHEN j.status = 'done'              THEN 'synced'
            WHEN j.status IN ('pending', 'running') THEN 'pending'
            ELSE j.status END                   AS sync_status,
       j.attempts,
       j.last_error,
       j.finished_at                            AS synced_at
  FROM Incidents i
  LEFT JOIN Embedding_Jobs j
    ON j.incident_id = i.incident_id AND j.narrative_version = i.narrative_version AND j.action = 'upsert';

ALTER TABLE Incidents ADD FULLTEXT INDEX ftx_incidents_text (title, narrative);
