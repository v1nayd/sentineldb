# SentinelDB data dictionary

> **Generated** by `npm run db:dictionary` from the live catalog (information_schema) of a database migrated to version 0015. Do not edit by hand; regenerate after a migration.
> Table names appear in lower case when generated on Windows (MySQL `lower_case_table_names = 1`); SQL in this project is written in the original mixed case and works on both.

Base tables: 18 · views: 8 · triggers: 40 · procedures/functions: 19

## assets

Inventory of servers, workstations, network devices and applications that incidents can affect.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| asset_id | int | no |  | PRI auto_increment |  |
| asset_name | varchar(150) | no |  |  |  |
| asset_type | varchar(30) | no |  |  |  |
| ip_address | varchar(45) | yes |  |  |  |
| criticality_level | tinyint | no |  |  |  |
| owner_department | varchar(100) | yes |  |  |  |
| last_audited_at | datetime | yes |  |  |  |

CHECK constraints:
- `chk_assets_criticality`: `(`criticality_level` between 1 and 5)`
- `chk_assets_type`: `(`asset_type` in (_utf8mb4\'server\',_utf8mb4\'workstation\',_utf8mb4\'network_device\',_utf8mb4\'application\'))`

Indexes: `PRIMARY` (asset_id) unique

## auth_events

Append-only log of logins / failures / blocks / logouts; the login rate limiter counts from it.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| auth_event_id | bigint | no |  | PRI auto_increment |  |
| event_type | varchar(20) | no |  | MUL |  |
| email_attempted | varchar(150) | yes |  | MUL |  |
| user_id | int | yes |  | MUL |  |
| ip | varchar(45) | yes |  | MUL |  |
| created_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Foreign keys: `user_id` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_auth_events_type`: `(`event_type` in (_utf8mb4\'login_success\',_utf8mb4\'login_failure\',_utf8mb4\'login_blocked\',_utf8mb4\'logout\',_utf8mb4\'password_changed\'))`

Indexes: `fk_auth_events_user` (user_id); `idx_auth_events_email_time` (email_attempted,created_at); `idx_auth_events_ip_time` (ip,created_at); `idx_auth_events_type_time` (event_type,created_at); `PRIMARY` (auth_event_id) unique

Triggers: `trg_auth_events_before_insert` (BEFORE INSERT); `trg_auth_events_before_update` (BEFORE UPDATE); `trg_auth_events_before_delete` (BEFORE DELETE)

## embedding_jobs

Outbox (M4): MySQL -> Qdrant propagation jobs, written by triggers in the changing transaction; processed by the sync worker.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| job_id | bigint | no |  | PRI auto_increment |  |
| incident_id | int | no |  | MUL |  |
| narrative_version | int | no |  |  | The Incidents.narrative_version this job propagates; (incident_id, narrative_version, action) is unique. |
| action | varchar(10) | no |  |  |  |
| status | varchar(12) | no | pending | MUL | pending -> running -> done \| superseded \| failed (after 5 attempts); running iff locked_at/locked_by set. |
| attempts | int | no | 0 |  |  |
| available_at | datetime | no | utc_timestamp() |  DEFAULT_GENERATED |  |
| locked_at | datetime | yes |  |  |  |
| locked_by | varchar(64) | yes |  |  |  |
| last_error | varchar(500) | yes |  |  |  |
| created_at | datetime | no | utc_timestamp() |  DEFAULT_GENERATED |  |
| finished_at | datetime | yes |  |  |  |

Foreign keys: `incident_id` → incidents.incident_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_jobs_action`: `(`action` in (_utf8mb4\'upsert\',_utf8mb4\'delete\'))`
- `chk_jobs_attempts`: `(`attempts` >= 0)`
- `chk_jobs_finished`: `((`status` in (_utf8mb4\'done\',_utf8mb4\'failed\',_utf8mb4\'superseded\')) = (`finished_at` is not null))`
- `chk_jobs_lock`: `((`status` = _utf8mb4\'running\') = ((`locked_at` is not null) and (`locked_by` is not null)))`
- `chk_jobs_status`: `(`status` in (_utf8mb4\'pending\',_utf8mb4\'running\',_utf8mb4\'done\',_utf8mb4\'failed\',_utf8mb4\'superseded\'))`
- `chk_jobs_version`: `(`narrative_version` >= 1)`

Indexes: `idx_jobs_claim` (status,available_at,job_id); `PRIMARY` (job_id) unique; `uq_jobs_version_action` (incident_id,narrative_version,action) unique

## incident_asset

M:N link incident-asset, with the impact on that asset (closure requires it to be described).

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| incident_id | int | no |  | PRI |  |
| asset_id | int | no |  | PRI |  |
| impact_description | text | yes |  |  |  |

Foreign keys: `asset_id` → assets.asset_id (ON DELETE RESTRICT); `incident_id` → incidents.incident_id (ON DELETE RESTRICT)

Indexes: `fk_iasset_asset` (asset_id); `PRIMARY` (incident_id,asset_id) unique

Triggers: `trg_incident_asset_after_insert` (AFTER INSERT); `trg_incident_asset_after_delete` (AFTER DELETE); `trg_incident_asset_before_insert` (BEFORE INSERT); `trg_incident_asset_before_update` (BEFORE UPDATE); `trg_incident_asset_before_delete` (BEFORE DELETE)

## incident_assignment_history

Audit: one row per assignment / reassignment. Written only by triggers; immutable.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| assignment_event_id | int | no |  | PRI auto_increment |  |
| incident_id | int | no |  | MUL |  |
| old_assignee | int | yes |  | MUL |  |
| new_assignee | int | yes |  | MUL |  |
| changed_by | int | no |  | MUL |  |
| actor_name_snapshot | varchar(100) | no |  |  |  |
| db_account | varchar(288) | no |  |  |  |
| source | varchar(10) | no |  |  |  |
| reason | varchar(500) | yes |  |  |  |
| changed_at | datetime | no |  |  |  |

Foreign keys: `changed_by` → users.user_id (ON DELETE RESTRICT); `incident_id` → incidents.incident_id (ON DELETE RESTRICT); `new_assignee` → users.user_id (ON DELETE RESTRICT); `old_assignee` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_iah_real_change`: `(not((`old_assignee` <=> `new_assignee`)))`
- `chk_iah_source`: `(`source` in (_utf8mb4\'import\',_utf8mb4\'runtime\'))`

Indexes: `fk_iah_changed_by` (changed_by); `fk_iah_new_assignee` (new_assignee); `fk_iah_old_assignee` (old_assignee); `idx_iah_incident_time` (incident_id,changed_at); `PRIMARY` (assignment_event_id) unique

Triggers: `trg_iah_before_update` (BEFORE UPDATE); `trg_iah_before_delete` (BEFORE DELETE)

## incident_evidence_history

Audit: IOC/asset linked, unlinked, IOC reviewed. Written only by triggers; immutable.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| evidence_event_id | int | no |  | PRI auto_increment |  |
| incident_id | int | no |  | MUL |  |
| ioc_id | int | yes |  | MUL |  |
| asset_id | int | yes |  | MUL |  |
| action | varchar(10) | no |  |  |  |
| detail | varchar(500) | yes |  |  |  |
| changed_by | int | no |  | MUL |  |
| actor_name_snapshot | varchar(100) | no |  |  |  |
| db_account | varchar(288) | no |  |  |  |
| source | varchar(10) | no |  |  |  |
| changed_at | datetime | no |  |  |  |

Foreign keys: `asset_id` → assets.asset_id (ON DELETE RESTRICT); `changed_by` → users.user_id (ON DELETE RESTRICT); `incident_id` → incidents.incident_id (ON DELETE RESTRICT); `ioc_id` → iocs.ioc_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_ieh_action`: `(`action` in (_utf8mb4\'linked\',_utf8mb4\'unlinked\',_utf8mb4\'reviewed\'))`
- `chk_ieh_one_target`: `((`ioc_id` is null) <> (`asset_id` is null))`
- `chk_ieh_review_is_ioc`: `((`action` <> _utf8mb4\'reviewed\') or (`ioc_id` is not null))`
- `chk_ieh_source`: `(`source` in (_utf8mb4\'import\',_utf8mb4\'runtime\'))`

Indexes: `fk_ieh_asset` (asset_id); `fk_ieh_changed_by` (changed_by); `fk_ieh_ioc` (ioc_id); `idx_ieh_incident_time` (incident_id,changed_at); `PRIMARY` (evidence_event_id) unique

Triggers: `trg_ieh_before_update` (BEFORE UPDATE); `trg_ieh_before_delete` (BEFORE DELETE)

## incident_ioc

M:N link incident-IOC, with the analyst's review decision (closure requires no pending review).

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| incident_id | int | no |  | PRI |  |
| ioc_id | int | no |  | PRI |  |
| notes | text | yes |  |  |  |
| review_status | varchar(10) | no | pending |  | pending \| confirmed \| dismissed. reviewed_by / reviewed_at are stamped by the trigger. |
| reviewed_by | int | yes |  | MUL |  |
| reviewed_at | datetime | yes |  |  |  |

Foreign keys: `incident_id` → incidents.incident_id (ON DELETE RESTRICT); `ioc_id` → iocs.ioc_id (ON DELETE RESTRICT); `reviewed_by` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_iioc_review_coherent`: `(((`review_status` = _utf8mb4\'pending\') and (`reviewed_by` is null) and (`reviewed_at` is null)) or ((`review_status` <> _utf8mb4\'pending\') and (`reviewed_by` is not null) and (`reviewed_at` is not null)))`
- `chk_iioc_review_status`: `(`review_status` in (_utf8mb4\'pending\',_utf8mb4\'confirmed\',_utf8mb4\'dismissed\'))`

Indexes: `fk_iioc_ioc` (ioc_id); `fk_iioc_reviewed_by` (reviewed_by); `PRIMARY` (incident_id,ioc_id) unique

Triggers: `trg_incident_ioc_after_insert` (AFTER INSERT); `trg_incident_ioc_after_update` (AFTER UPDATE); `trg_incident_ioc_after_delete` (AFTER DELETE); `trg_incident_ioc_before_insert` (BEFORE INSERT); `trg_incident_ioc_before_update` (BEFORE UPDATE); `trg_incident_ioc_before_delete` (BEFORE DELETE)

## incident_playbook

M:N record of which playbook was applied to which incident, and when.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| incident_id | int | no |  | PRI |  |
| playbook_id | int | no |  | PRI |  |
| applied_at | datetime | yes | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Foreign keys: `incident_id` → incidents.incident_id (ON DELETE RESTRICT); `playbook_id` → playbooks.playbook_id (ON DELETE RESTRICT)

Indexes: `fk_ipb_playbook` (playbook_id); `PRIMARY` (incident_id,playbook_id) unique

## incident_status_history

Audit: one row per real status change (and the NULL -> open origin). Written only by triggers; immutable.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| history_id | int | no |  | PRI auto_increment |  |
| incident_id | int | no |  | MUL |  |
| old_status | varchar(20) | yes |  |  |  |
| new_status | varchar(20) | no |  |  |  |
| changed_by | int | no |  | MUL | Acting end user asserted by the application (@sentinel_actor), FK RESTRICT. |
| actor_name_snapshot | varchar(100) | no |  |  |  |
| db_account | varchar(288) | no |  |  | The real MySQL account (USER()) that made the change. |
| source | varchar(10) | no |  |  | import = the migrator/import account (seed replay); runtime = any other account. |
| reason | varchar(500) | yes |  |  |  |
| changed_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Foreign keys: `changed_by` → users.user_id (ON DELETE RESTRICT); `incident_id` → incidents.incident_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_ish_new_status`: `(`new_status` in (_utf8mb4\'open\',_utf8mb4\'investigating\',_utf8mb4\'contained\',_utf8mb4\'resolved\',_utf8mb4\'closed\'))`
- `chk_ish_old_status`: `((`old_status` is null) or (`old_status` in (_utf8mb4\'open\',_utf8mb4\'investigating\',_utf8mb4\'contained\',_utf8mb4\'resolved\',_utf8mb4\'closed\')))`
- `chk_ish_real_change`: `(not((`old_status` <=> `new_status`)))`
- `chk_ish_source`: `(`source` in (_utf8mb4\'import\',_utf8mb4\'runtime\'))`

Indexes: `fk_ish_changed_by` (changed_by); `fk_ish_incident` (incident_id); `PRIMARY` (history_id) unique

Triggers: `trg_ish_before_update` (BEFORE UPDATE); `trg_ish_before_delete` (BEFORE DELETE)

## incidents

The central entity: one security incident, its narrative (embedded into Qdrant) and its lifecycle state.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| incident_id | int | no |  | PRI auto_increment |  |
| title | varchar(200) | no |  | MUL |  |
| narrative | text | no |  |  |  |
| severity | varchar(10) | no |  |  |  |
| status | varchar(20) | no | open | MUL | Changed only through transition_incident / close_incident (validated against Status_Transitions). |
| reported_by | int | no |  | MUL |  |
| assigned_to | int | yes |  | MUL | Changed only through reassign_incident (admin). |
| created_at | datetime | no | CURRENT_TIMESTAMP | MUL DEFAULT_GENERATED | Set by trigger from the DB clock (import sessions may replay history with @sentinel_clock). |
| resolved_at | datetime | yes |  |  | Maintained by trigger: set on resolving, kept on closing, cleared on reopening. |
| updated_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED | Maintained by trigger: last real change (a no-op UPDATE does not move it). |
| narrative_version | int unsigned | no | 1 |  | Maintained by trigger: +1 per narrative change; fences vector-index writes (M4). |
| archived_at | datetime | yes |  |  | Set by archive_incident (admin, closed incidents only). Archived incidents are read-only. |
| archived_by | int | yes |  | MUL |  |
| archive_reason | varchar(500) | yes |  |  |  |

Foreign keys: `archived_by` → users.user_id (ON DELETE RESTRICT); `assigned_to` → users.user_id (ON DELETE RESTRICT); `reported_by` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_incidents_archive`: `(((`archived_at` is null) and (`archived_by` is null) and (`archive_reason` is null)) or ((`archived_at` is not null) and (`archived_by` is not null) and (`archive_reason` is not null) and (`status` = _utf8mb4\'closed\')))`
- `chk_incidents_narrative_version`: `(`narrative_version` >= 1)`
- `chk_incidents_resolution`: `((`status` in (_utf8mb4\'resolved\',_utf8mb4\'closed\')) = (`resolved_at` is not null))`
- `chk_incidents_resolved_after_created`: `((`resolved_at` is null) or (`resolved_at` >= `created_at`))`
- `chk_incidents_severity`: `(`severity` in (_utf8mb4\'low\',_utf8mb4\'medium\',_utf8mb4\'high\',_utf8mb4\'critical\'))`
- `chk_incidents_status`: `(`status` in (_utf8mb4\'open\',_utf8mb4\'investigating\',_utf8mb4\'contained\',_utf8mb4\'resolved\',_utf8mb4\'closed\'))`

Indexes: `fk_incidents_archived_by` (archived_by); `fk_incidents_reported_by` (reported_by); `ftx_incidents_text` (title,narrative); `idx_incidents_assignee_status` (assigned_to,status); `idx_incidents_created_at` (created_at); `idx_incidents_status_severity` (status,severity); `PRIMARY` (incident_id) unique

Triggers: `trg_incidents_after_insert` (AFTER INSERT); `trg_incidents_outbox_after_insert` (AFTER INSERT); `trg_incidents_after_update` (AFTER UPDATE); `trg_incidents_outbox_after_update` (AFTER UPDATE); `trg_incidents_before_insert` (BEFORE INSERT); `trg_incidents_before_update` (BEFORE UPDATE); `trg_incidents_assignee_active` (BEFORE UPDATE); `trg_incidents_before_delete` (BEFORE DELETE)

## iocs

Indicators of compromise (IP, domain, file hash, email, URL), unique per (type, value).

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| ioc_id | int | no |  | PRI auto_increment |  |
| ioc_type | varchar(20) | no |  | MUL |  |
| ioc_value | varchar(255) | no |  | MUL |  |
| first_seen | datetime | yes | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |
| threat_level | varchar(10) | yes |  |  |  |

CHECK constraints:
- `chk_iocs_threat`: `(`threat_level` in (_utf8mb4\'low\',_utf8mb4\'medium\',_utf8mb4\'high\',_utf8mb4\'critical\'))`
- `chk_iocs_type`: `(`ioc_type` in (_utf8mb4\'ip\',_utf8mb4\'domain\',_utf8mb4\'file_hash\',_utf8mb4\'email\',_utf8mb4\'url\'))`

Indexes: `idx_iocs_value` (ioc_value); `PRIMARY` (ioc_id) unique; `uq_iocs_type_value` (ioc_type,ioc_value) unique

## notes

Analyst notes on an incident. Append-only; the author is always the acting user.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| note_id | int | no |  | PRI auto_increment |  |
| incident_id | int | no |  | MUL |  |
| author_id | int | no |  | MUL | Must equal the acting user (trigger SDB21). |
| content | text | no |  |  |  |
| created_at | datetime | yes | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Foreign keys: `author_id` → users.user_id (ON DELETE RESTRICT); `incident_id` → incidents.incident_id (ON DELETE RESTRICT)

Indexes: `fk_notes_author` (author_id); `fk_notes_incident` (incident_id); `PRIMARY` (note_id) unique

Triggers: `trg_notes_before_insert` (BEFORE INSERT); `trg_notes_before_update` (BEFORE UPDATE); `trg_notes_before_delete` (BEFORE DELETE)

## playbooks

Response procedures, by incident type.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| playbook_id | int | no |  | PRI auto_increment |  |
| name | varchar(150) | no |  | UNI |  |
| applicable_incident_type | varchar(50) | yes |  |  |  |
| steps_description | text | yes |  |  |  |
| created_by | int | yes |  | MUL |  |

Foreign keys: `created_by` → users.user_id (ON DELETE RESTRICT)

Indexes: `fk_playbooks_created_by` (created_by); `name` (name) unique; `PRIMARY` (playbook_id) unique

## schema_migrations

Migration bookkeeping (version, checksum). Not accessible to the runtime account.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| version | int | no |  | PRI |  |
| name | varchar(100) | no |  |  |  |
| checksum | char(64) | no |  |  |  |
| applied_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Indexes: `PRIMARY` (version) unique

## sessions

Server-side login sessions. Only SHA-256 of the cookie token is stored; 8 h absolute, 30 min idle; revocable.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| token_hash | char(64) | no |  | PRI | SHA-256 hex of the random cookie token; the token itself is never stored. |
| user_id | int | no |  | MUL |  |
| created_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |
| last_seen_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |
| expires_at | datetime | no | CURRENT_TIMESTAMP |  DEFAULT_GENERATED | Set by trigger: created_at + 8 hours. Not writable by the runtime account. |
| revoked_at | datetime | yes |  |  |  |
| ip | varchar(45) | yes |  |  |  |
| user_agent | varchar(200) | yes |  |  |  |

Foreign keys: `user_id` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_sessions_times`: `(`expires_at` > `created_at`)`
- `chk_sessions_token_hash`: `regexp_like(`token_hash`,_utf8mb4\'^[0-9a-f]{64}$\')`

Indexes: `idx_sessions_user_active` (user_id,revoked_at); `PRIMARY` (token_hash) unique

Triggers: `trg_sessions_before_insert` (BEFORE INSERT); `trg_sessions_before_update` (BEFORE UPDATE)

## status_transitions

Reference data: the lifecycle state machine (allowed from -> to, who may, reason required?).

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| from_status | varchar(20) | no |  | PRI |  |
| to_status | varchar(20) | no |  | PRI |  |
| requires_role | varchar(20) | yes |  |  |  |
| requires_reason | tinyint(1) | no | 0 |  |  |
| description | varchar(200) | no |  |  |  |

CHECK constraints:
- `chk_st_distinct`: `(`from_status` <> `to_status`)`
- `chk_st_from`: `(`from_status` in (_utf8mb4\'open\',_utf8mb4\'investigating\',_utf8mb4\'contained\',_utf8mb4\'resolved\',_utf8mb4\'closed\'))`
- `chk_st_role`: `((`requires_role` is null) or (`requires_role` = _utf8mb4\'admin\'))`
- `chk_st_to`: `(`to_status` in (_utf8mb4\'open\',_utf8mb4\'investigating\',_utf8mb4\'contained\',_utf8mb4\'resolved\',_utf8mb4\'closed\'))`

Indexes: `PRIMARY` (from_status,to_status) unique

## user_account_history

Audit: account created, role changed, (de)activated, password or e-mail changed. Trigger-written; immutable.

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| account_event_id | int | no |  | PRI auto_increment |  |
| user_id | int | no |  | MUL |  |
| action | varchar(20) | no |  |  |  |
| detail | varchar(300) | yes |  |  |  |
| changed_by | int | yes |  | MUL |  |
| actor_name_snapshot | varchar(100) | yes |  |  |  |
| db_account | varchar(288) | no |  |  |  |
| source | varchar(10) | no |  |  |  |
| changed_at | datetime | no |  |  |  |

Foreign keys: `changed_by` → users.user_id (ON DELETE RESTRICT); `user_id` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_uah_action`: `(`action` in (_utf8mb4\'created\',_utf8mb4\'role_changed\',_utf8mb4\'deactivated\',_utf8mb4\'reactivated\',_utf8mb4\'password_changed\',_utf8mb4\'email_changed\',_utf8mb4\'renamed\'))`
- `chk_uah_actor`: `((`changed_by` is not null) or (`source` = _utf8mb4\'import\'))`
- `chk_uah_source`: `(`source` in (_utf8mb4\'import\',_utf8mb4\'runtime\'))`

Indexes: `fk_uah_changed_by` (changed_by); `idx_uah_user_time` (user_id,changed_at); `PRIMARY` (account_event_id) unique

Triggers: `trg_uah_before_update` (BEFORE UPDATE); `trg_uah_before_delete` (BEFORE DELETE)

## users

People who use SentinelDB. role = analyst | admin. Never deleted (audit rows reference them).

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| user_id | int | no |  | PRI auto_increment |  |
| name | varchar(100) | no |  |  |  |
| email | varchar(150) | no |  | UNI |  |
| password_hash | varchar(255) | no |  |  | scrypt hash ($scrypt$ln=17,r=8,p=1$...). NOT readable by the runtime account; login uses auth_lookup(). |
| role | varchar(20) | no | analyst |  |  |
| is_active | tinyint(1) | no | 1 |  | Deactivated users cannot log in, act (SDB02) or be assigned (SDB42); their sessions are revoked. |
| deactivated_at | datetime | yes |  |  |  |
| deactivated_by | int | yes |  | MUL |  |
| password_changed_at | datetime | yes |  |  |  |
| created_at | datetime | yes | CURRENT_TIMESTAMP |  DEFAULT_GENERATED |  |

Foreign keys: `deactivated_by` → users.user_id (ON DELETE RESTRICT)

CHECK constraints:
- `chk_users_deactivation`: `(((0 <> `is_active`) and (`deactivated_at` is null)) or ((0 = `is_active`) and (`deactivated_at` is not null)))`
- `chk_users_role`: `(`role` in (_utf8mb4\'analyst\',_utf8mb4\'admin\'))`

Indexes: `email` (email) unique; `fk_users_deactivated_by` (deactivated_by); `PRIMARY` (user_id) unique

Triggers: `trg_users_after_insert` (AFTER INSERT); `trg_users_after_update` (AFTER UPDATE); `trg_users_before_insert` (BEFORE INSERT); `trg_users_before_update` (BEFORE UPDATE); `trg_users_before_delete` (BEFORE DELETE)

## Views

| View | Columns |
|---|---|
| analyst_workload_view | user_id, name, open_incidents, avg_resolution_hours |
| incident_summary_view | incident_id, title, severity, status, reported_by, reporter_name, assigned_to, assignee_name, created_at, resolved_at, updated_at, narrative_version, ioc_count, pending_ioc_count, asset_count, max_asset_criticality, note_count, last_status_change_at, hours_to_resolve |
| incident_sync_view | incident_id, narrative_version, sync_status, attempts, last_error, synced_at |
| monthly_trend_view | month, created, critical, high, medium, low, resolved_or_closed |
| mttr_by_severity_view | severity, resolved_incidents, mean_hours_to_first_resolution, min_hours, max_hours |
| recurring_ioc_view | ioc_id, ioc_type, ioc_value, threat_level, incident_count, high_or_critical_incidents, first_incident_at, last_incident_at |
| severity_status_matrix_view | severity, open_count, investigating_count, contained_count, resolved_count, closed_count, total_count, severity_rank |
| workload_by_assignee_view | user_id, name, role, active_incidents, active_high_or_critical, resolved_incidents, avg_hours_to_resolve |

## Stored procedures and functions

| Name | Type | Security | Purpose |
|---|---|---|---|
| archive_incident | PROCEDURE | DEFINER | Archive a closed incident (admin only). Archived incidents leave default lists and the vector index. |
| auth_lookup | PROCEDURE | DEFINER | Login: account and password hash for one exact e-mail (no actor needed). |
| close_incident | PROCEDURE | DEFINER | Close a resolved incident after checking IOC reviews and asset impact descriptions (admin only). |
| create_user | PROCEDURE | DEFINER | Create an account (admin only). Result set: user_id. |
| reassign_incident | PROCEDURE | DEFINER | Assign or reassign an incident with a handover note (admin only), atomically. |
| sdb_assert_incident_writable | PROCEDURE | DEFINER | Raises SDB31/SDB13/SDB14 unless the incident exists and its evidence may still change. |
| sdb_txn_active | PROCEDURE | DEFINER | TRUE if the session already has a transaction open. |
| set_password_hash | PROCEDURE | DEFINER | Store a new password hash (the user themself or an admin). Revokes the user's sessions. |
| set_user_active | PROCEDURE | DEFINER | Deactivate or reactivate an account (admin only). Deactivation revokes sessions. |
| set_user_role | PROCEDURE | DEFINER | Change a role (admin only; the last active admin cannot be demoted). |
| transition_incident | PROCEDURE | DEFINER | Move an incident along Status_Transitions (not to closed: use close_incident). |
| sdb_actor | FUNCTION | DEFINER | The acting end user (@sentinel_actor). Raises SDB01/SDB02 instead of returning NULL; rejects deactivated users. |
| sdb_actor_or_import | FUNCTION | DEFINER | sdb_actor(), except that an import session without @sentinel_actor yields NULL instead of an error. |
| sdb_is_import | FUNCTION | DEFINER | TRUE when the connected account is the account that defined the SentinelDB routines (migrator/import). |
| sdb_is_password_hash | FUNCTION | DEFINER | TRUE for a $scrypt$ln=..,r=..,p=..$salt$hash string as produced by src/lib/auth/password.ts. |
| sdb_now | FUNCTION | DEFINER | Clock for every lifecycle timestamp: @sentinel_clock for import sessions only, otherwise UTC_TIMESTAMP(). |
| sdb_role | FUNCTION | DEFINER |  |
| sdb_source | FUNCTION | DEFINER | Audit source label: import or runtime. |
| sdb_user_name | FUNCTION | DEFINER |  |
