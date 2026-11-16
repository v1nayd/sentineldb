-- Least-privilege grants for the RUNTIME account. Template: {{DB}} = schema, {{APP}} = account name.
-- Applied by scripts/apply-grants.sh as a privileged DB admin AFTER migrations (table/column grants need the tables
-- to exist). The script first revokes EVERYTHING from the account, so this file is the single source of truth.
--
-- WHY per-table/column grants and not "DML on schema.*":
--   MySQL privileges are additive. A broad schema-level grant can never be narrowed by a later table-level grant, so
--   restrictions (immutable audit rows, no direct status changes) are only enforceable if the broad grant never exists.
--
-- Principles
--   * What the DATABASE can enforce is "no application path may do X". It cannot tell an analyst from an admin: both use
--     the same DB account, so role-specific rules (who may edit assets, who may close incidents) live in server code (M3).
--     Likewise a fully compromised app server holding these credentials can call any privileged procedure in the
--     app's name. These grants limit SQL-injection / application-bug blast radius, not a stolen credential.
--   * No DELETE on anything that is evidence or identity (Users, Assets, IOCs, Incidents, Notes, Playbooks).
--     Retirement/archiving (Milestone 2/3) replaces deletion; ON DELETE CASCADE can therefore never fire from the app.
--   * Incident_Status_History: SELECT only. Rows will be written by a trigger running with the DEFINER's privileges
--     (MySQL triggers execute as their definer, so the app account needs no INSERT on audit tables).
--   * Incidents: the app may INSERT only the user-supplied columns (so status/resolved_at/created_at take their
--     defaults = 'open', NULL, now) and UPDATE only descriptive columns. status / assigned_to / archive state change ONLY
--     via the four SQL SECURITY DEFINER procedures below (EXECUTE grants); resolved_at, updated_at and
--     narrative_version are computed by triggers. The triggers (migrations 0007/0008) enforce the same rules on every
--     path, so even a privileged account cannot skip them.
--   * Notes are append-only.
--   * schema_migrations, DDL, GRANT: nothing.
-- Milestone 2 (schema 0003-0011): EXECUTE on four lifecycle procedures, Incident_IOC.review_status, read access to the new
-- audit tables, the state-machine table and the analytic views. Nothing else changed; tests/grants.test.ts holds the
-- exact allow-list.

-- Users (Milestone 3): NO write grant at all, and password_hash is NOT readable.
--   Reading: every column except password_hash (column-level SELECT; note that `SELECT *` from Users is therefore denied
--   for the app, by design). Login reads the hash only through auth_lookup(email), one exact account at a time.
--   Writing: only the DEFINER procedures create_user / set_user_role / set_user_active / set_password_hash, which check
--   the acting user; the Users triggers (0013) enforce the same rules on every path, incl. the last-admin rule.
--   (Milestone 1-2 allowed INSERT (name, email, password_hash) and UPDATE (name, password_hash) here.)
GRANT SELECT (user_id, name, email, role, is_active, deactivated_at, deactivated_by, password_changed_at, created_at) ON `{{DB}}`.Users TO '{{APP}}'@'%';

-- Assets: asset_id (key) and asset_type (classification; correcting it means registering a new asset, because changing
-- the type would silently rewrite what historical incident evidence refers to) are not updatable. Everything else is
-- ordinary inventory maintenance. Which APP ROLE may do it (admin vs analyst) is decided by server-side RBAC in M3.
GRANT SELECT ON `{{DB}}`.Assets TO '{{APP}}'@'%';
GRANT INSERT (asset_name, asset_type, ip_address, criticality_level, owner_department) ON `{{DB}}`.Assets TO '{{APP}}'@'%';
GRANT UPDATE (asset_name, ip_address, criticality_level, owner_department, last_audited_at) ON `{{DB}}`.Assets TO '{{APP}}'@'%';

GRANT SELECT ON `{{DB}}`.Incidents TO '{{APP}}'@'%';
GRANT INSERT (title, narrative, severity, reported_by) ON `{{DB}}`.Incidents TO '{{APP}}'@'%';
GRANT UPDATE (title, narrative, severity) ON `{{DB}}`.Incidents TO '{{APP}}'@'%';

GRANT SELECT, INSERT ON `{{DB}}`.IOCs TO '{{APP}}'@'%';
GRANT UPDATE (threat_level) ON `{{DB}}`.IOCs TO '{{APP}}'@'%';

-- Incident_IOC: linking/unlinking and the review decision. reviewed_by / reviewed_at are NOT writable; the trigger stamps
-- them from the acting user and the DB clock. Every link, unlink and review is audited (Incident_Evidence_History).
GRANT SELECT, INSERT, DELETE ON `{{DB}}`.Incident_IOC TO '{{APP}}'@'%';
GRANT UPDATE (notes, review_status) ON `{{DB}}`.Incident_IOC TO '{{APP}}'@'%';

GRANT SELECT, INSERT, DELETE ON `{{DB}}`.Incident_Asset TO '{{APP}}'@'%';
GRANT UPDATE (impact_description) ON `{{DB}}`.Incident_Asset TO '{{APP}}'@'%';

-- Playbooks: playbook_id and created_by (authorship attribution) are fixed once written; content is editable.
GRANT SELECT ON `{{DB}}`.Playbooks TO '{{APP}}'@'%';
GRANT INSERT (name, applicable_incident_type, steps_description, created_by) ON `{{DB}}`.Playbooks TO '{{APP}}'@'%';
GRANT UPDATE (name, applicable_incident_type, steps_description) ON `{{DB}}`.Playbooks TO '{{APP}}'@'%';

-- Incident_Playbook: applied_at is set by the database clock, not by the caller.
GRANT SELECT, DELETE ON `{{DB}}`.Incident_Playbook TO '{{APP}}'@'%';
GRANT INSERT (incident_id, playbook_id) ON `{{DB}}`.Incident_Playbook TO '{{APP}}'@'%';

GRANT SELECT ON `{{DB}}`.Incident_Status_History TO '{{APP}}'@'%';

GRANT SELECT ON `{{DB}}`.Notes TO '{{APP}}'@'%';
GRANT INSERT (incident_id, author_id, content) ON `{{DB}}`.Notes TO '{{APP}}'@'%';

GRANT SELECT ON `{{DB}}`.analyst_workload_view TO '{{APP}}'@'%';

-- Milestone 2: audit tables are read-only (written by triggers), the state machine is read-only reference data.
GRANT SELECT ON `{{DB}}`.Incident_Assignment_History TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.Incident_Evidence_History TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.Status_Transitions TO '{{APP}}'@'%';

GRANT SELECT ON `{{DB}}`.incident_summary_view TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.severity_status_matrix_view TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.workload_by_assignee_view TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.mttr_by_severity_view TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.recurring_ioc_view TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.monthly_trend_view TO '{{APP}}'@'%';

-- The only way the runtime account changes status, assignment or archive state. Helper routines (sdb_*) are NOT
-- granted: triggers and these procedures call them with their definer's privileges.
GRANT EXECUTE ON PROCEDURE `{{DB}}`.transition_incident TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.close_incident TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.reassign_incident TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.archive_incident TO '{{APP}}'@'%';

-- Milestone 3: accounts and authentication.
-- Sessions: the app opens a session (token hash + user + client metadata; timestamps come from the trigger), refreshes
-- last_seen_at and revokes it. It cannot extend expires_at or re-point a session to another user.
GRANT SELECT ON `{{DB}}`.Sessions TO '{{APP}}'@'%';
GRANT INSERT (token_hash, user_id, ip, user_agent) ON `{{DB}}`.Sessions TO '{{APP}}'@'%';
GRANT UPDATE (last_seen_at, revoked_at) ON `{{DB}}`.Sessions TO '{{APP}}'@'%';
-- Auth_Events: append-only log of logins, also read by the login rate limiter. created_at comes from the DB clock.
GRANT SELECT ON `{{DB}}`.Auth_Events TO '{{APP}}'@'%';
GRANT INSERT (event_type, email_attempted, user_id, ip) ON `{{DB}}`.Auth_Events TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.User_Account_History TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.auth_lookup TO '{{APP}}'@'%';
-- Milestone 4: the sync worker runs as this account. Jobs are created by triggers (definer rights); the app may only
-- re-queue a job (repair after reconciliation) and move a job through its states. Nothing here can touch an incident.
GRANT SELECT ON `{{DB}}`.Embedding_Jobs TO '{{APP}}'@'%';
GRANT INSERT (incident_id, narrative_version, action) ON `{{DB}}`.Embedding_Jobs TO '{{APP}}'@'%';
GRANT UPDATE (status, attempts, available_at, locked_at, locked_by, last_error, finished_at) ON `{{DB}}`.Embedding_Jobs TO '{{APP}}'@'%';
GRANT SELECT ON `{{DB}}`.incident_sync_view TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.create_user TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.set_user_role TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.set_user_active TO '{{APP}}'@'%';
GRANT EXECUTE ON PROCEDURE `{{DB}}`.set_password_hash TO '{{APP}}'@'%';
