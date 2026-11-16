-- 0010 — Analytic views (Phase 1 spec section 11: incident_summary_view; roadmap M2: severity x status, workload incl.
-- unassigned and zero-incident users, MTTR, recurring IOCs, monthly trend).
--
-- Views run with their definer's privileges (SQL SECURITY DEFINER, MySQL's default), so the runtime account needs
-- SELECT on the view only. WHICH user may see which view (e.g. analysts must not see other analysts' metrics,
-- spec section 10) is enforced by the API layer in M3; the database cannot tell analyst from admin.
--
-- Archived incidents are excluded from operational views (summary, matrix, workload, trend) and included in the
-- historical ones (MTTR, recurring IOCs), because archiving retires an incident from work queues, not from history.
-- The Phase 1 analyst_workload_view is left exactly as submitted; workload_by_assignee_view supersedes it.

-- One row per incident with its evidence counts and timings: what list and detail pages read.
CREATE VIEW incident_summary_view AS
SELECT i.incident_id, i.title, i.severity, i.status,
       i.reported_by, r.name AS reporter_name,
       i.assigned_to, a.name AS assignee_name,
       i.created_at, i.resolved_at, i.updated_at, i.narrative_version,
       COALESCE(ioc.ioc_count, 0)         AS ioc_count,
       COALESCE(ioc.pending_ioc_count, 0) AS pending_ioc_count,
       COALESCE(ast.asset_count, 0)       AS asset_count,
       ast.max_asset_criticality,
       (SELECT COUNT(*) FROM Notes n WHERE n.incident_id = i.incident_id) AS note_count,
       (SELECT MAX(h.changed_at) FROM Incident_Status_History h WHERE h.incident_id = i.incident_id) AS last_status_change_at,
       ROUND(TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at) / 60, 2) AS hours_to_resolve
FROM Incidents i
JOIN Users r ON r.user_id = i.reported_by
LEFT JOIN Users a ON a.user_id = i.assigned_to
LEFT JOIN (SELECT incident_id, COUNT(*) AS ioc_count,
                  COUNT(CASE WHEN review_status = 'pending' THEN 1 END) AS pending_ioc_count
             FROM Incident_IOC GROUP BY incident_id) ioc ON ioc.incident_id = i.incident_id
LEFT JOIN (SELECT ia.incident_id, COUNT(*) AS asset_count, MAX(s.criticality_level) AS max_asset_criticality
             FROM Incident_Asset ia JOIN Assets s ON s.asset_id = ia.asset_id GROUP BY ia.incident_id) ast
       ON ast.incident_id = i.incident_id
WHERE i.archived_at IS NULL;

-- Severity x status matrix. The severity list is a derived table so that a severity with no incidents still shows 0s.
CREATE VIEW severity_status_matrix_view AS
SELECT s.severity,
       COUNT(CASE WHEN i.status = 'open'          THEN 1 END) AS open_count,
       COUNT(CASE WHEN i.status = 'investigating' THEN 1 END) AS investigating_count,
       COUNT(CASE WHEN i.status = 'contained'     THEN 1 END) AS contained_count,
       COUNT(CASE WHEN i.status = 'resolved'      THEN 1 END) AS resolved_count,
       COUNT(CASE WHEN i.status = 'closed'        THEN 1 END) AS closed_count,
       COUNT(i.incident_id) AS total_count,
       s.severity_rank
FROM (SELECT 'critical' AS severity, 4 AS severity_rank UNION ALL SELECT 'high', 3
      UNION ALL SELECT 'medium', 2 UNION ALL SELECT 'low', 1) s
LEFT JOIN Incidents i ON i.severity = s.severity AND i.archived_at IS NULL
GROUP BY s.severity, s.severity_rank;

-- Workload per user (every user, including those with zero incidents and admins), plus one "(unassigned)" row.
-- Fixes what the Phase 1 view leaves out: unassigned work, non-analyst assignees, archived incidents counted as load.
CREATE VIEW workload_by_assignee_view AS
SELECT u.user_id, u.name, u.role,
       COUNT(CASE WHEN i.status IN ('open','investigating','contained') THEN 1 END) AS active_incidents,
       COUNT(CASE WHEN i.status IN ('open','investigating','contained') AND i.severity IN ('high','critical') THEN 1 END)
         AS active_high_or_critical,
       COUNT(CASE WHEN i.status IN ('resolved','closed') THEN 1 END) AS resolved_incidents,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at)) / 60, 2) AS avg_hours_to_resolve
FROM Users u
LEFT JOIN Incidents i ON i.assigned_to = u.user_id AND i.archived_at IS NULL
GROUP BY u.user_id, u.name, u.role
UNION ALL
SELECT NULL, '(unassigned)', NULL,
       COUNT(CASE WHEN i.status IN ('open','investigating','contained') THEN 1 END),
       COUNT(CASE WHEN i.status IN ('open','investigating','contained') AND i.severity IN ('high','critical') THEN 1 END),
       COUNT(CASE WHEN i.status IN ('resolved','closed') THEN 1 END),
       NULL
FROM Incidents i
WHERE i.assigned_to IS NULL AND i.archived_at IS NULL;

-- Mean time to (first) resolution per severity, measured on the audit trail: from the NULL -> open origin row to the
-- first transition into 'resolved' (ADR-2 item 7). Using history, not resolved_at, keeps reopened incidents honest:
-- resolved_at moves when an incident is reopened and resolved again; the first resolution does not.
CREATE VIEW mttr_by_severity_view AS
SELECT i.severity,
       COUNT(*) AS resolved_incidents,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, o.changed_at, f.first_resolved_at)) / 60, 2) AS mean_hours_to_first_resolution,
       ROUND(MIN(TIMESTAMPDIFF(MINUTE, o.changed_at, f.first_resolved_at)) / 60, 2) AS min_hours,
       ROUND(MAX(TIMESTAMPDIFF(MINUTE, o.changed_at, f.first_resolved_at)) / 60, 2) AS max_hours
FROM Incidents i
JOIN Incident_Status_History o ON o.incident_id = i.incident_id AND o.old_status IS NULL
JOIN (SELECT incident_id, MIN(changed_at) AS first_resolved_at
        FROM Incident_Status_History WHERE new_status = 'resolved' GROUP BY incident_id) f
  ON f.incident_id = i.incident_id
GROUP BY i.severity;

-- IOCs seen in two or more incidents (HAVING), ignoring links an analyst dismissed as false positives.
CREATE VIEW recurring_ioc_view AS
SELECT c.ioc_id, c.ioc_type, c.ioc_value, c.threat_level,
       COUNT(DISTINCT ii.incident_id) AS incident_count,
       COUNT(DISTINCT CASE WHEN i.severity IN ('high','critical') THEN ii.incident_id END) AS high_or_critical_incidents,
       MIN(i.created_at) AS first_incident_at,
       MAX(i.created_at) AS last_incident_at
FROM IOCs c
JOIN Incident_IOC ii ON ii.ioc_id = c.ioc_id AND ii.review_status <> 'dismissed'
JOIN Incidents i ON i.incident_id = ii.incident_id
GROUP BY c.ioc_id, c.ioc_type, c.ioc_value, c.threat_level
HAVING COUNT(DISTINCT ii.incident_id) >= 2;

-- Incidents created per calendar month (UTC), by severity, and how many of them are resolved or closed by now.
CREATE VIEW monthly_trend_view AS
SELECT DATE_FORMAT(i.created_at, '%Y-%m') AS month,
       COUNT(*) AS created,
       COUNT(CASE WHEN i.severity = 'critical' THEN 1 END) AS critical,
       COUNT(CASE WHEN i.severity = 'high'     THEN 1 END) AS high,
       COUNT(CASE WHEN i.severity = 'medium'   THEN 1 END) AS medium,
       COUNT(CASE WHEN i.severity = 'low'      THEN 1 END) AS low,
       COUNT(CASE WHEN i.status IN ('resolved','closed') THEN 1 END) AS resolved_or_closed
FROM Incidents i
WHERE i.archived_at IS NULL
GROUP BY DATE_FORMAT(i.created_at, '%Y-%m');
