# Index review (Milestone 2)

Method: `npm run db:explain` builds a **scaled copy** of the schema (50,000 incidents, ~172,000 status-history rows, 100,000 IOC links, 20,000 IOCs; scratch schema `sentineldb_p1check`, dev data untouched), then compares access paths with index hints using `EXPLAIN` and `EXPLAIN ANALYZE` (median of 5 runs) plus rows actually read. Raw plans: [`evidence/explain.txt`](evidence/explain.txt). At the 240-incident demo size every plan is a trivial scan, which is why the scaled copy exists.

Caveat: data is synthetic and uniformly generated; timings are from one Windows laptop and show **relative** differences, not production numbers.

| Query | Before | After | Decision |
|---|---|---|---|
| Analyst's active queue (`assigned_to = ? AND status IN (...)`) | `idx_incidents_assigned_to`: 1,112 rows read, 2.0 ms | `idx_incidents_assignee_status (assigned_to, status)`: 225 rows, 0.62 ms (chosen by the optimizer unprompted) | **Add** composite; **drop** the single-column index (redundant left prefix) — migration 0011 |
| One month of incidents (`created_at` range) | full scan, 51,215 rows, 21.7 ms | `idx_incidents_created_at`: 2,420 rows, 2.5 ms | **Add** — 0011 |
| Status timeline of one incident (`ORDER BY changed_at`) | FK index + sort: 5 rows, 0.049 ms | candidate `(incident_id, changed_at)`: 5 rows, 0.046 ms | **Rejected**: an incident has 3–5 history rows, no measurable gain, extra write cost |
| Dashboard tiles: counts by status × severity | no index: 60,016 rows, 32 ms | Phase 1 `idx_incidents_status_severity`: 10,003 rows, 9.8 ms (optimizer picks it) | **Keep** Phase 1 index — it earns its place for this shape |
| Manager queue (high/critical, open/investigating, oldest first, `LIMIT 50`) | `idx_incidents_status_severity` forced: 4,004 rows, 10.1 ms | optimizer's choice (`idx_incidents_created_at`, ordered scan that stops at the limit): 611 rows, 0.89 ms | No change; **the optimizer correctly ignores the Phase 1 index here** — forcing it is 11× slower |
| IOC by value alone (defect D8) | `uq_iocs_type_value` via skip scan: 9 rows, 0.054 ms | `idx_iocs_value`: 2 rows, 0.032 ms | **Keep** `idx_iocs_value`, with the corrected rationale: not "existence check" (the unique key serves that) but value-only lookups. The gain is small; MySQL 8 skip-scans the unique key. Honest verdict: marginal, kept because it is cheap and it is a Phase 1 artefact |
| Incidents sharing an IOC (correlation, M4) | without FK index: 100,002 rows, 24.4 ms | `fk_iioc_ioc (ioc_id)`: 6 rows, 0.028 ms | No new index; the FK index already exists. Confirms the correlation join is index-supported |

Things that surprised me while measuring (and that a reviewer may ask about):

- Creating a composite index whose prefix covers a foreign key makes MySQL silently drop the implicit FK index. The timeline comparison needed an explicit single-column index to be fair.
- My first draft of 0011 added `Incident_Status_History(incident_id, changed_at)` on theory. The measurement did not support it, so it was removed before the migration was finalised. The migration file records the rejection.

## Milestone 4 additions (functional, not part of the EXPLAIN review above)

- `ftx_incidents_text` — FULLTEXT(title, narrative): required by `MATCH … AGAINST` for the keyword baseline of the
  evaluation and the lexical fallback. Not a performance choice: MySQL cannot run `MATCH` without it.
- `idx_jobs_claim (status, available_at, job_id)` on `Embedding_Jobs`: serves the worker's claim query
  (`WHERE status = 'pending' AND available_at <= now ORDER BY job_id`). The table is small (one row per change); the
  index also bounds which rows `FOR UPDATE SKIP LOCKED` touches. Not measured on the scaled copy.
