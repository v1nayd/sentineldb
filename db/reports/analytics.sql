-- Analytic reports over the incident data. Each block is one named query and the SQL concepts it demonstrates.
-- Run: npm run db:reports -- analytics       (as the least-privilege runtime account: SELECT only)
-- Archived incidents are excluded from operational reports and kept in historical ones (same rule as the views).

-- name: severity_status_matrix
-- shows: view over a derived table + LEFT JOIN, conditional aggregation COUNT(CASE ...), ORDER BY
SELECT severity, open_count, investigating_count, contained_count, resolved_count, closed_count, total_count
FROM severity_status_matrix_view
ORDER BY severity_rank DESC;

-- name: analyst_workload
-- shows: view with LEFT JOIN + GROUP BY + UNION ALL (zero-incident users and the unassigned bucket are included)
SELECT name, role, active_incidents, active_high_or_critical, resolved_incidents, avg_hours_to_resolve
FROM workload_by_assignee_view
ORDER BY active_incidents DESC, name;

-- name: slower_than_average_resolvers
-- shows: GROUP BY + HAVING with a scalar subquery (compare each analyst with the team average)
SELECT u.name, COUNT(*) AS resolved_incidents,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at)) / 60, 1) AS avg_hours
FROM Incidents i
JOIN Users u ON u.user_id = i.assigned_to
WHERE i.resolved_at IS NOT NULL
GROUP BY u.user_id, u.name
HAVING AVG(TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at)) >
       (SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, resolved_at)) FROM Incidents WHERE resolved_at IS NOT NULL)
ORDER BY avg_hours DESC;

-- name: mttr_by_severity
-- shows: view joining the audit trail to a grouped derived table (first resolution per incident), AVG/MIN/MAX
SELECT severity, resolved_incidents, mean_hours_to_first_resolution, min_hours, max_hours
FROM mttr_by_severity_view
ORDER BY FIELD(severity, 'critical', 'high', 'medium', 'low');

-- name: median_hours_to_resolve_by_severity
-- shows: window functions ROW_NUMBER() and COUNT() OVER (PARTITION BY ...) to compute a median MySQL has no function for
SELECT severity, MAX(cnt) AS resolved_incidents, ROUND(AVG(hours), 1) AS median_hours
FROM (SELECT i.severity, TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at) / 60 AS hours,
             ROW_NUMBER() OVER (PARTITION BY i.severity ORDER BY TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at)) AS rn,
             COUNT(*)     OVER (PARTITION BY i.severity) AS cnt
        FROM Incidents i WHERE i.resolved_at IS NOT NULL) ranked
WHERE rn IN (FLOOR((cnt + 1) / 2), CEIL((cnt + 1) / 2))
GROUP BY severity
ORDER BY FIELD(severity, 'critical', 'high', 'medium', 'low');

-- name: recurring_iocs
-- shows: view with GROUP BY + HAVING COUNT(DISTINCT ...) >= 2, ORDER BY + LIMIT
SELECT ioc_type, ioc_value, threat_level, incident_count, high_or_critical_incidents, first_incident_at, last_incident_at
FROM recurring_ioc_view
ORDER BY incident_count DESC, last_incident_at DESC
LIMIT 15;

-- name: incident_pairs_sharing_iocs
-- shows: self-join on a junction table, GROUP BY a pair, HAVING; this relational evidence feeds hybrid ranking in M4
SELECT a.incident_id AS incident_a, b.incident_id AS incident_b, COUNT(*) AS shared_iocs,
       GROUP_CONCAT(c.ioc_value ORDER BY c.ioc_value SEPARATOR ', ') AS shared_values
FROM Incident_IOC a
JOIN Incident_IOC b ON b.ioc_id = a.ioc_id AND b.incident_id > a.incident_id
JOIN IOCs c ON c.ioc_id = a.ioc_id
WHERE a.review_status <> 'dismissed' AND b.review_status <> 'dismissed'
GROUP BY a.incident_id, b.incident_id
HAVING COUNT(*) >= 2
ORDER BY shared_iocs DESC, incident_a
LIMIT 15;

-- name: most_affected_assets
-- shows: three-table JOIN, GROUP BY, HAVING, MAX over a CASE-mapped ordinal
SELECT s.asset_name, s.asset_type, s.criticality_level, COUNT(*) AS incidents,
       ELT(MAX(FIELD(i.severity, 'low', 'medium', 'high', 'critical')), 'low', 'medium', 'high', 'critical') AS worst_severity
FROM Incident_Asset ia
JOIN Assets s ON s.asset_id = ia.asset_id
JOIN Incidents i ON i.incident_id = ia.incident_id
GROUP BY s.asset_id, s.asset_name, s.asset_type, s.criticality_level
HAVING COUNT(*) >= 3
ORDER BY incidents DESC, s.criticality_level DESC
LIMIT 15;

-- name: incidents_touching_critical_iocs
-- shows: IN (subquery) with a nested JOIN, ORDER BY
SELECT i.incident_id, i.title, i.severity, i.status
FROM Incidents i
WHERE i.archived_at IS NULL
  AND i.incident_id IN (SELECT l.incident_id FROM Incident_IOC l JOIN IOCs c ON c.ioc_id = l.ioc_id
                         WHERE c.threat_level = 'critical' AND l.review_status = 'confirmed')
ORDER BY i.created_at DESC
LIMIT 15;

-- name: active_incidents_without_notes
-- shows: NOT EXISTS (anti-join)
SELECT i.incident_id, i.title, i.status, i.assigned_to
FROM Incidents i
WHERE i.status IN ('investigating', 'contained') AND i.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM Notes n WHERE n.incident_id = i.incident_id AND n.author_id = i.assigned_to)
ORDER BY i.incident_id;

-- name: stalled_investigations
-- shows: latest row per group with ROW_NUMBER(), scalar subquery for "now" (the data's own latest event), DATEDIFF
SELECT x.incident_id, i.title, x.new_status AS status, x.changed_at AS since,
       DATEDIFF((SELECT MAX(changed_at) FROM Incident_Status_History), x.changed_at) AS days_without_progress
FROM (SELECT h.*, ROW_NUMBER() OVER (PARTITION BY h.incident_id ORDER BY h.history_id DESC) AS rn
        FROM Incident_Status_History h) x
JOIN Incidents i ON i.incident_id = x.incident_id
WHERE x.rn = 1 AND x.new_status IN ('investigating', 'contained') AND i.archived_at IS NULL
  AND DATEDIFF((SELECT MAX(changed_at) FROM Incident_Status_History), x.changed_at) > 14
ORDER BY days_without_progress DESC;

-- name: monthly_trend_with_running_total
-- shows: view + window SUM() OVER (ORDER BY ...) for a running total
SELECT month, created, critical, high, medium, low, resolved_or_closed,
       SUM(created) OVER (ORDER BY month) AS running_total
FROM monthly_trend_view
ORDER BY month;

-- name: reassignment_rate_by_severity
-- shows: derived table of per-incident counts, CASE inside aggregates, percentage
SELECT i.severity, COUNT(*) AS assigned_incidents,
       SUM(CASE WHEN a.assignments > 1 THEN 1 ELSE 0 END) AS reassigned,
       ROUND(100 * SUM(CASE WHEN a.assignments > 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS reassigned_pct
FROM Incidents i
JOIN (SELECT incident_id, COUNT(*) AS assignments FROM Incident_Assignment_History GROUP BY incident_id) a
  ON a.incident_id = i.incident_id
GROUP BY i.severity
ORDER BY FIELD(i.severity, 'critical', 'high', 'medium', 'low');

-- name: reopened_incidents
-- shows: EXISTS on the audit trail, correlated scalar subquery for the reopen reason
SELECT i.incident_id, i.title, i.status,
       (SELECT h.reason FROM Incident_Status_History h
         WHERE h.incident_id = i.incident_id AND h.old_status = 'closed' ORDER BY h.history_id LIMIT 1) AS reopen_reason
FROM Incidents i
WHERE EXISTS (SELECT 1 FROM Incident_Status_History h WHERE h.incident_id = i.incident_id AND h.old_status = 'closed')
ORDER BY i.incident_id;

-- name: evidence_hygiene
-- shows: aggregation over the evidence audit log (links, unlinks, dismissals per analyst)
SELECT e.actor_name_snapshot AS analyst,
       COUNT(CASE WHEN e.action = 'linked'   THEN 1 END) AS linked,
       COUNT(CASE WHEN e.action = 'unlinked' THEN 1 END) AS unlinked,
       COUNT(CASE WHEN e.action = 'reviewed' AND e.detail LIKE '%dismissed' THEN 1 END) AS dismissed,
       COUNT(CASE WHEN e.action = 'reviewed' AND e.detail LIKE '%confirmed' THEN 1 END) AS confirmed
FROM Incident_Evidence_History e
GROUP BY e.changed_by, e.actor_name_snapshot
ORDER BY linked DESC;
