-- 0011 — Indexes chosen from the query workload and MEASURED with EXPLAIN ANALYZE on a 50,000-incident scaled copy
-- (scripts/explain.ts reproduces it; raw plans in docs/evidence/explain.txt; decisions in docs/INDEXING.md).
--
-- 1. Analyst work queue: WHERE assigned_to = ? AND status IN (...) ORDER BY updated_at.
--    The Phase 1 index idx_incidents_assigned_to(assigned_to) finds the analyst's rows but then reads every one of them
--    to filter on status (measured: 1,112 rows read, 2.06 ms). (assigned_to, status) answers both predicates from the
--    index (225 rows, 0.66 ms) and the optimizer picks it unprompted. It also serves the foreign key on assigned_to, so
--    the single-column index becomes a redundant left prefix and is DROPPED (it would only cost space and write time).
CREATE INDEX idx_incidents_assignee_status ON Incidents (assigned_to, status);
DROP INDEX idx_incidents_assigned_to ON Incidents;

-- 2. Trend and date-range dashboards: WHERE created_at >= ? AND created_at < ? (monthly_trend_view, reports).
--    Measured: full scan of 51,215 rows (22.9 ms) -> range scan of 2,420 rows (2.7 ms) for one month.
--    The optimizer also uses it to read the manager queue in created_at order and stop at the LIMIT.
CREATE INDEX idx_incidents_created_at ON Incidents (created_at);

-- Considered and REJECTED after measuring: Incident_Status_History(incident_id, changed_at) for the timeline query.
-- An incident has 3-5 history rows, so the foreign-key index (incident_id) plus a tiny sort is just as fast
-- (0.07 ms vs 0.10 ms, within noise). Adding it would cost write time on every status change for no measured gain.
