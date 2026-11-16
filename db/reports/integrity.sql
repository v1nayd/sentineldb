-- Audit-trail integrity checks. EVERY query must return ZERO rows; any row is a violation, printed with its evidence.
-- Run: npm run db:reports -- integrity      (runs as the least-privilege runtime account: SELECT only)
-- Used by tests/seed-demo.test.ts on the replayed demo dataset and by tests/lifecycle.test.ts.
-- SQL shown: GROUP BY + HAVING, correlated and EXISTS subqueries, scalar subqueries, window functions (LAG,
-- ROW_NUMBER), UNION ALL.

-- name: origin_row_missing_or_duplicated
-- why: every incident has exactly one NULL -> open origin row (ADR-2 item 7)
SELECT i.incident_id, COUNT(h.history_id) AS origin_rows
FROM Incidents i
LEFT JOIN Incident_Status_History h ON h.incident_id = i.incident_id AND h.old_status IS NULL
GROUP BY i.incident_id
HAVING COUNT(h.history_id) <> 1;

-- name: origin_row_not_first
-- why: nothing can precede the origin row
SELECT h.incident_id, h.history_id
FROM Incident_Status_History h
WHERE h.old_status IS NULL
  AND EXISTS (SELECT 1 FROM Incident_Status_History p WHERE p.incident_id = h.incident_id AND p.history_id < h.history_id);

-- name: status_chain_broken
-- why: each row's old_status equals the previous row's new_status (a contiguous chain)
SELECT incident_id, history_id, old_status, previous_new_status
FROM (SELECT incident_id, history_id, old_status,
             LAG(new_status) OVER (PARTITION BY incident_id ORDER BY history_id) AS previous_new_status
        FROM Incident_Status_History) x
WHERE previous_new_status IS NOT NULL AND NOT (old_status <=> previous_new_status);

-- name: status_time_goes_backwards
-- why: replayed history is chronological
SELECT incident_id, history_id, changed_at, previous_changed_at
FROM (SELECT incident_id, history_id, changed_at,
             LAG(changed_at) OVER (PARTITION BY incident_id ORDER BY history_id) AS previous_changed_at
        FROM Incident_Status_History) x
WHERE changed_at < previous_changed_at;

-- name: current_status_disagrees_with_history
-- why: the last history row is the current status
SELECT i.incident_id, i.status, h.new_status AS last_history_status
FROM Incidents i
JOIN Incident_Status_History h
  ON h.history_id = (SELECT MAX(x.history_id) FROM Incident_Status_History x WHERE x.incident_id = i.incident_id)
WHERE h.new_status <> i.status;

-- name: resolution_incoherent
-- why: resolved_at is set exactly for resolved/closed incidents and never precedes creation (CHECK constraints, D4)
SELECT incident_id, status, created_at, resolved_at
FROM Incidents
WHERE (status IN ('resolved','closed')) <> (resolved_at IS NOT NULL) OR resolved_at < created_at;

-- name: assignment_chain_broken
-- why: the first assignment starts from NULL; each later one starts from the previous assignee
SELECT incident_id, assignment_event_id, old_assignee, previous_new_assignee
FROM (SELECT incident_id, assignment_event_id, old_assignee,
             LAG(new_assignee) OVER (PARTITION BY incident_id ORDER BY assignment_event_id) AS previous_new_assignee,
             ROW_NUMBER() OVER (PARTITION BY incident_id ORDER BY assignment_event_id) AS n
        FROM Incident_Assignment_History) x
WHERE (n = 1 AND old_assignee IS NOT NULL) OR (n > 1 AND NOT (old_assignee <=> previous_new_assignee));

-- name: assignee_disagrees_with_history
-- why: the current assignee is the last assignment's new_assignee (NULL if never assigned)
SELECT i.incident_id, i.assigned_to,
       (SELECT a.new_assignee FROM Incident_Assignment_History a
         WHERE a.incident_id = i.incident_id ORDER BY a.assignment_event_id DESC LIMIT 1) AS last_assigned
FROM Incidents i
WHERE NOT (i.assigned_to <=> (SELECT a.new_assignee FROM Incident_Assignment_History a
                               WHERE a.incident_id = i.incident_id ORDER BY a.assignment_event_id DESC LIMIT 1));

-- name: closed_without_complete_evidence
-- why: close_incident's rule holds for every closed incident (no pending IOC, every asset impact described)
SELECT i.incident_id,
       (SELECT COUNT(*) FROM Incident_IOC l WHERE l.incident_id = i.incident_id AND l.review_status = 'pending') AS pending_iocs,
       (SELECT COUNT(*) FROM Incident_Asset a WHERE a.incident_id = i.incident_id
                                              AND TRIM(COALESCE(a.impact_description, '')) = '') AS undocumented_assets
FROM Incidents i
WHERE i.status = 'closed'
  AND (EXISTS (SELECT 1 FROM Incident_IOC l WHERE l.incident_id = i.incident_id AND l.review_status = 'pending')
    OR EXISTS (SELECT 1 FROM Incident_Asset a WHERE a.incident_id = i.incident_id AND TRIM(COALESCE(a.impact_description, '')) = ''));

-- name: evidence_links_disagree_with_history
-- why: every current link has a 'linked' event, and no current link's latest link/unlink event is 'unlinked'
SELECT l.incident_id, l.ioc_id, l.asset_id, 'current link without a linked event' AS problem
FROM (SELECT incident_id, ioc_id, NULL AS asset_id FROM Incident_IOC
      UNION ALL SELECT incident_id, NULL, asset_id FROM Incident_Asset) l
WHERE NOT EXISTS (SELECT 1 FROM Incident_Evidence_History e
                   WHERE e.incident_id = l.incident_id AND e.action = 'linked'
                     AND e.ioc_id <=> l.ioc_id AND e.asset_id <=> l.asset_id)
UNION ALL
SELECT e.incident_id, e.ioc_id, e.asset_id, 'link exists but its latest event is unlinked'
FROM Incident_Evidence_History e
WHERE e.action = 'unlinked'
  AND e.evidence_event_id = (SELECT MAX(x.evidence_event_id) FROM Incident_Evidence_History x
                              WHERE x.incident_id = e.incident_id AND x.ioc_id <=> e.ioc_id AND x.asset_id <=> e.asset_id
                                AND x.action IN ('linked','unlinked'))
  AND (EXISTS (SELECT 1 FROM Incident_IOC c WHERE c.incident_id = e.incident_id AND c.ioc_id = e.ioc_id)
    OR EXISTS (SELECT 1 FROM Incident_Asset a WHERE a.incident_id = e.incident_id AND a.asset_id = e.asset_id));

-- name: reviewer_disagrees_with_history
-- why: reviewed_by on a link is the actor of its latest review event
SELECT l.incident_id, l.ioc_id, l.reviewed_by, e.changed_by AS last_review_actor
FROM Incident_IOC l
JOIN Incident_Evidence_History e
  ON e.evidence_event_id = (SELECT MAX(x.evidence_event_id) FROM Incident_Evidence_History x
                             WHERE x.incident_id = l.incident_id AND x.ioc_id = l.ioc_id AND x.action = 'reviewed')
WHERE l.review_status <> 'pending' AND NOT (l.reviewed_by <=> e.changed_by);

-- name: archived_but_not_closed
-- why: only closed incidents can be archived (CHECK chk_incidents_archive)
SELECT incident_id, status, archived_at FROM Incidents WHERE archived_at IS NOT NULL AND status <> 'closed';
