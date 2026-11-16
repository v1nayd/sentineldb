-- Live demo: the DATABASE enforces the incident lifecycle, the audit trail and the closure rule by itself.
-- It runs as the least-privilege RUNTIME account, i.e. with exactly the rights the web application has.
-- Needs the demo dataset (npm run db:reset && npm run db:grants && npm run db:seed -- demo).
--
--   mysql -h127.0.0.1 -P3307 -u sentinel_app -p --force --table sentineldb < db/demo/live_demo.sql
--
-- --force keeps going after the statements that are SUPPOSED to fail; every "ERROR ..." line in the output is a rule
-- refusing something. Each run adds one demo incident (closed + archived at the end); `npm run db:seed` after a
-- `db:reset` restores the clean dataset.
-- Demo users from the seed: 1 Priya Raman (admin), 3 Aisha Khan (analyst), 4 Tomas Rivera (analyst).

SELECT '1. Who am I? The runtime account (the web app''s account), not an administrator' AS step;
SELECT USER() AS connected_as;

SELECT '2. Least privilege: the app account cannot read password hashes, set a status directly, or touch the audit trail' AS step;
SELECT password_hash FROM Users LIMIT 1;
UPDATE Incidents SET status = 'closed' WHERE incident_id = 1;
DELETE FROM Incident_Status_History WHERE incident_id = 1;

SELECT '3. No acting user = no change. The trigger refuses anonymous writes (SDB01)' AS step;
SET @sentinel_actor = NULL;
INSERT INTO Incidents (title, narrative, severity, reported_by)
VALUES ('Anonymous write', 'Should be refused.', 'low', 3);

SELECT '4. Aisha (analyst) reports an incident. It must start open; the trigger writes the first history row' AS step;
SET @sentinel_actor = 3;
INSERT INTO Incidents (title, narrative, severity, reported_by)
VALUES ('LIVE DEMO: suspicious login from new country',
        'Aisha saw a VPN login for a finance user from an unusual country at 03:10, followed by mailbox rule changes.',
        'high', 3);
SET @id = LAST_INSERT_ID();
SELECT incident_id, status, assigned_to, created_at, resolved_at, narrative_version FROM Incidents WHERE incident_id = @id;
SELECT old_status, new_status, actor_name_snapshot, db_account, source, changed_at FROM Incident_Status_History WHERE incident_id = @id;

SELECT '5. Only an admin may assign work. Aisha tries, and is refused (SDB11); Priya (admin) assigns it' AS step;
CALL reassign_incident(@id, 3, 'I will take it myself');
SET @sentinel_actor = 1;
CALL reassign_incident(@id, 3, 'Triage: Aisha owns this one');
SELECT old_assignee, new_assignee, actor_name_snapshot, reason FROM Incident_Assignment_History WHERE incident_id = @id;

SELECT '6. The state machine (Status_Transitions table). open -> resolved is not an allowed move (SDB10)' AS step;
SELECT from_status, to_status, requires_role, requires_reason FROM Status_Transitions;
SET @sentinel_actor = 3;
CALL transition_incident(@id, 'resolved', NULL);
CALL transition_incident(@id, 'investigating', NULL);

SELECT '7. Evidence: Aisha links an indicator (IOC) and an affected asset. Both start "not yet reviewed"' AS step;
INSERT INTO IOCs (ioc_type, ioc_value, threat_level) VALUES ('ip', '203.0.113.77', 'high');
SET @ioc = LAST_INSERT_ID();
INSERT INTO Incident_IOC (incident_id, ioc_id) VALUES (@id, @ioc);
INSERT INTO Incident_Asset (incident_id, asset_id) VALUES (@id, 1);
SELECT action, ioc_id, asset_id, actor_name_snapshot FROM Incident_Evidence_History WHERE incident_id = @id;

SELECT '8. Aisha resolves it. resolved_at is filled in by the trigger, not by the app' AS step;
CALL transition_incident(@id, 'resolved', NULL);
SELECT incident_id, status, resolved_at FROM Incidents WHERE incident_id = @id;

SELECT '9. Closing: analysts may not close (SDB11); the admin is blocked while evidence is unreviewed (SDB12)' AS step;
CALL close_incident(@id, NULL);
SET @sentinel_actor = 1;
CALL close_incident(@id, NULL);

SELECT '10. Aisha reviews the IOC and describes the asset impact; now the admin can close it' AS step;
SET @sentinel_actor = 3;
UPDATE Incident_IOC SET review_status = 'confirmed' WHERE incident_id = @id AND ioc_id = @ioc;
UPDATE Incident_Asset SET impact_description = 'VPN gateway logs reviewed; no lateral movement' WHERE incident_id = @id AND asset_id = 1;
SELECT review_status, reviewed_by, reviewed_at FROM Incident_IOC WHERE incident_id = @id;
SET @sentinel_actor = 1;
CALL close_incident(@id, 'Reviewed: credential reset, MFA enforced');
SELECT incident_id, status, resolved_at FROM Incidents WHERE incident_id = @id;

SELECT '11. A closed incident is read-only (SDB13)' AS step;
UPDATE Incidents SET title = 'Rewriting history' WHERE incident_id = @id;

SELECT '12. The complete audit trail, written only by triggers' AS step;
SELECT old_status, new_status, actor_name_snapshot, source, reason, changed_at FROM Incident_Status_History WHERE incident_id = @id ORDER BY history_id;

SELECT '13. Transactions: a reassignment inside a transaction that is rolled back leaves no trace' AS step;
SELECT incident_id INTO @open_id FROM Incidents WHERE status = 'open' AND assigned_to IS NOT NULL AND archived_at IS NULL ORDER BY incident_id LIMIT 1;
SELECT @open_id AS incident, (SELECT assigned_to FROM Incidents WHERE incident_id = @open_id) AS assignee_before,
       (SELECT COUNT(*) FROM Incident_Assignment_History WHERE incident_id = @open_id) AS audit_rows_before;
START TRANSACTION;
CALL reassign_incident(@open_id, 4, 'Handover to Tomas');
SELECT (SELECT assigned_to FROM Incidents WHERE incident_id = @open_id) AS assignee_inside_txn,
       (SELECT COUNT(*) FROM Incident_Assignment_History WHERE incident_id = @open_id) AS audit_rows_inside_txn;
ROLLBACK;
SELECT (SELECT assigned_to FROM Incidents WHERE incident_id = @open_id) AS assignee_after_rollback,
       (SELECT COUNT(*) FROM Incident_Assignment_History WHERE incident_id = @open_id) AS audit_rows_after_rollback;

SELECT '14. Archive (soft delete): the incident and its history stay, but it becomes read-only (SDB14)' AS step;
CALL archive_incident(@id, 'Live demo finished');
UPDATE Incidents SET severity = 'low' WHERE incident_id = @id;
DELETE FROM Incidents WHERE incident_id = @id;

SELECT '15. Analytics views over the 240-incident dataset' AS step;
SELECT severity, open_count, investigating_count, contained_count, resolved_count, closed_count, total_count
FROM severity_status_matrix_view ORDER BY severity_rank DESC;
SELECT name, role, active_incidents, active_high_or_critical, resolved_incidents, avg_hours_to_resolve
FROM workload_by_assignee_view ORDER BY active_incidents DESC, name LIMIT 6;
SELECT * FROM mttr_by_severity_view;

SET @sentinel_actor = NULL;
SELECT 'Done. Every ERROR above was the database refusing a rule violation, under the same account the app uses.' AS step;
