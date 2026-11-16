# SentinelDB — Phase 2 audit, compliance matrix and roadmap
> **Archived working note.** Written with the help of Claude Code (an AI coding assistant) during development. Where it says "I" or "you", that is the assistant's review text addressed to the team, not a team member. Kept as project history. How AI was used in this project: [docs/AI_USAGE.md](../AI_USAGE.md).


Status key (used everywhere in this repo):
**Planned** (only in a document) · **Implemented** (code/SQL exists) · **Executed** (I ran it) · **Verified** (an automated test or independent check asserts the behaviour).

Review follow-up status: see [`REVIEW_RESPONSE_M1.md`](REVIEW_RESPONSE_M1.md); decisions: [`DECISIONS.md`](../DECISIONS.md).

Evidence base: the ZIP you supplied (`phase1/`, byte-identical copy; hashes in `docs/phase1.sha256`), plus real services run in this workspace: MySQL 8.0.46, Qdrant 1.19.2, Node 22.22. I opened the requirements document, the spec, the SQL, the ER PNG and the draw.io XML in full, and **1 of 15** execution screenshots (it shows MySQL Workbench rejecting a bad `role` with error 3819, i.e. CHECK constraints are enforced). I did not individually review the other 14 and I did not redo them.

---

## 1. What Phase 1 actually is

| Item | Classification | Evidence |
|---|---|---|
| 10-table MySQL schema (PK/FK/UNIQUE/CHECK, composite keys on 3 junction tables, 3 indexes, 1 view, 1 ALTER) | **Implemented, Executed, Verified** | I loaded `sentineldb-ddl-mysql.sql` into MySQL 8.0.46 and compared it with `db/migrations/0001` across columns, keys, FK rules, CHECK clauses, indexes and view text: identical (`tests/baseline-equivalence.test.ts`, 8 tests; a deliberate mutation made it fail, so the test has teeth). Your screenshots are the original submission evidence. |
| ER diagram (PNG + draw.io) | **Implemented, partly inconsistent** | Title reads "Sentinal DB" (typo, in both files). Most connectors carry a "1" label but no many-side marker, so M:N/1:N reading depends on text labels. I did not verify every connector. Not edited, per your instruction. |
| Relational schema, normalization, justification | **Designed** in the spec (§13–14, §17) | Sound for 1NF–3NF. |
| Trigger-based status audit | **Designed but not implemented** | `information_schema` shows 0 triggers, 0 routines. The Phase 1 SQL inserts the history row by hand, and the spec's claim that history is "populated exclusively by trigger" is not true of the submitted schema. |
| `close_incident()`, transactional reassignment | **Designed but not implemented** | Same query: 0 routines. |
| Vector search, Qdrant | **Designed**, now **Executed** as a slice | See §4. |
| Next.js app, auth, RBAC, rate limiting | **Designed but not implemented** | Only a health-check shell exists. |
| Spec §15/§16/§18/§22 (PostgreSQL DDL, `psql`, `tsvector`, `EXTRACT`, `FILTER`, `AFTER UPDATE OF status` trigger syntax, "EXPLAIN ANALYZE", resume bullets) | **Incorrect or inconsistent** with the MySQL submission | Docs must be rewritten for MySQL. Do **not** reuse the spec's resume bullets. |
| Spec §19 ("not yet executed on real Postgres") | **Stale** | Superseded by your MySQL screenshots. |

### Defects in the submitted schema (each probed on real MySQL, not guessed)

| # | Defect | Probe result |
|---|---|---|
| D1 | Lifecycle is not enforced | `UPDATE Incidents SET status='closed'` straight from `open` succeeds; no history row; `resolved_at` stays NULL. |
| D2 | Audit trail can be forged and is not automatic | Any writer can `INSERT` a history row with any actor and any timestamp. |
| D3 | Audit trail is destroyed with its incident | `ON DELETE CASCADE`: deleting incident 1 removed its history row (2 → 1). Contradicts the goal of audit retention. |
| D4 | Impossible incident states are accepted | `status='open'` with `resolved_at` earlier than `created_at` inserted fine. |
| D5 | Spec's closure rule is not representable | `Incident_IOC` has only `(incident_id, ioc_id, notes)`, so there is nothing to mark "reviewed". |
| D6 | No assignment audit | Reassignment changes `assigned_to` and leaves no trace. |
| D7 | No change tracking for sync | No `updated_at` or narrative version, so stale-vector detection needs a schema change. |
| D8 | `idx_iocs_value` justification is wrong | Its stated purpose ("existence check before insert") is already served by `uq_iocs_type_value` (EXPLAIN: `const`). It is still useful for value-only lookups (EXPLAIN: `ref`), so **keep it** and fix the rationale. |
| D9 | `DATETIME` + `SYSTEM` time zone | Timestamps are zone-less and depend on server config. Phase 2 pins sessions to UTC. |

One suspicion I **retracted** after probing: I expected `idx_incidents_assigned_to` to duplicate the FK's implicit index. It does not. MySQL silently replaces the implicit index when an explicit one exists.

---

## 2. Requirements-compliance matrix (official "Level 3" document)

| Requirement | Status now | Gap / next step |
|---|---|---|
| Unique title, 2-member team | Not checkable here | Confirm title uniqueness with the instructor. |
| SQL + Vector database | MySQL **Executed/Verified**; Qdrant **Executed/Verified** (slice) | Full integration in M4. |
| ER diagram, relational schema, keys, constraints | **Done** (Phase 1) | Regenerate a Phase 2 ER diagram after migrations (keep Phase 1 untouched). |
| DDL: CREATE, ALTER, DROP | CREATE, ALTER done. **DROP not demonstrated**: it is commented out in the spec and absent from the `.sql` | M2: a small, executed DDL demo script that drops a scratch object. |
| Indexes, views | 3 indexes, 1 view | M2: workload-driven review with real `EXPLAIN`; analytic views. |
| DML + JOIN, GROUP BY, **HAVING**, ORDER BY, aggregates, **subqueries** | Basic only. HAVING and subqueries not demonstrated | M2 reports. |
| ≥ 4 advanced concepts | **1.5 of 4**: view (implemented), vector (slice executed). Triggers, procedures, transactions: 0 | M2 delivers triggers, procedures, transactions, indexing/EXPLAIN. M4 adds full vector + full-text. |
| Vector DB documentation (what is embedded, model, storage, metric, retrieval) | Implemented in code, documented in `docs/ARCHITECTURE.md` and `docs/MODEL.md` | Evaluation write-up in M4. |
| Next.js UI with forms, tables, search, dashboards | Shell only | M5. |
| App → DB via backend/API, secrets in env | Env validation + server-only DB access **Implemented**; health route **Verified** | Domain APIs in M3. |
| ≥ 2 roles, RBAC | Role column exists. Nothing enforced | M3. |
| DB-level validation | CHECK/FK/UNIQUE exist; D1, D4, D5 show the gaps | M2. |
| Security: no plaintext secrets/passwords | `.env` git-ignored; seed accounts cannot log in; real hashing arrives with auth | M3. |
| Documentation checklist (13 items) | Roughly 60% in the spec | Missing: data dictionary, screenshots of the running app, test results (partly here), PostgreSQL → MySQL corrections. |
| Git/GitHub with individual contributions | **Not started** (no repo; I made no commits and invented no history) | See §6. |
| Demo (causal chain action → transaction → trigger → state change → analytics) | Not yet | M6. |
| Originality | Risk (see §5, evaluator criticism 1) | The evaluation and explainable ranking are the defence. |

---

## 3. Architecture decisions (challenged, not rubber-stamped)

| Decision | Choice | Why / honest downside |
|---|---|---|
| Relational engine | **MySQL 8.0** (kept) | Your submission is MySQL and the assignment allows it. Downsides: no row-level security, no `CHECK` across tables, DDL is non-transactional, no partial indexes. All handled below. |
| Data access | **`mysql2` + hand-written SQL + Zod**, no ORM | Triggers, `SIGNAL`, procedures, session variables for actor attribution and `SELECT … FOR UPDATE SKIP LOCKED` are all raw SQL anyway. An ORM adds a second source of truth for the schema and hides exactly what an evaluator will ask about. Cost: more hand-written mapping code. |
| Migrations | Tiny custom runner, sha256-checked, immutable history | MySQL DDL auto-commits, so a failed migration can leave partial changes. Mitigation: recorded only on success, dev `db:reset`. A tool like Flyway would not fix this. |
| Embeddings | `all-MiniLM-L6-v2` (Apache-2.0, 384-d, ~90 MB, CPU), in-process via transformers.js | Small and laptop-friendly. Weaker than larger models on domain text; max 256 tokens (we flag truncation). Model choice is configurable and the evaluation will report which model produced the numbers. |
| Vector store | **Qdrant 1.19.2** + client 1.19.0 (matched minor versions) | Holds **derived data only** (id + hash payload, no text). Rebuildable from MySQL. |
| Authorization boundary | Next.js server + DB account separation + procedures | MySQL cannot authenticate end users. The DB can enforce *invariants* (lifecycle, audit, closure), not *identity*. The app account is trusted; stated openly. |

### Open product decision (not decided by me)

The written spec limits analysts to incidents they reported or are assigned to, but "have we seen this before?" benefits from cross-incident visibility. An earlier draft of this audit proposed a redacted cross-incident view as a default. **That proposal is withdrawn as a default**: it changes the access policy, and IOC values and asset names can themselves be sensitive. Until the team chooses, M3/M4 implement the **original strict policy**. Options and costs are in [`DECISIONS.md` ADR-1](../DECISIONS.md).

---

## 4. What Milestone 1 delivered (all executed here)

- Repo scaffold, pinned deps + lockfile, `.env.example`, Docker Compose file (**unverified here**: Docker Hub is blocked).
- Migration runner + baseline migration equal to Phase 1 (**verified**).
- Local embedding pipeline **cross-checked** against an independent onnxruntime + tokenizers implementation: cosine 1.000000 on 6 texts including the 256-token truncation case. It found a real transformers.js 3.8.1 quirk (truncation drops `[SEP]`), which is fixed in `src/lib/embedding.ts`.
- Vertical slice (`npm run spike`): MySQL → embed → Qdrant → reworded query → Qdrant top-5 → resolved to authoritative MySQL rows with IOC/asset counts → staleness check. 12 incidents, 3 queries, 13/13 spike checks pass.
- Automated tests against real MySQL and Qdrant (24 at the end of M1; 47 after the first review follow-up; 71 after the final review corrections — see `REVIEW_RESPONSE_M1.md` and `REVIEW_RESPONSE_M1_FINAL.md`).
- Health endpoint: 200 with both services up, 503 with Qdrant stopped, recovery after restart (**executed**; not yet an automated test).

**What the spike does *not* prove (read before quoting any of it):** 12 hand-written incidents and 3 queries written by the same author is a smoke test, not an evaluation. The raw cosine scores also show why similarity alone is not evidence: in the phishing query, an unrelated *closed password-spraying* incident (0.441) outranks the executive-impersonation incident (0.403), and unrelated incidents score ≈ 0.39–0.44. That is exactly the gap relational evidence (shared IOCs, assets) must close in M4, and it must be measured, not assumed.

---

## 5. Likely evaluator criticisms and the planned answer

1. *"Semantic search over tickets is a tutorial pattern."* → The contribution is explainable hybrid ranking + held-out evaluation against keyword and vector-only baselines, reported honestly even if hybrid loses.
2. *"Is the second database justified?"* → Free-text similarity is not expressible with B-tree/FULLTEXT; the evaluation compares both on identical queries.
3. *"What if MySQL and Qdrant disagree?"* → Outbox/embedding-job table, per-incident narrative version + hash, reconciliation job, lexical fallback labelled as such (M4). Today only the staleness *detector* exists (hash in payload).
4. *"Trigger knows no app user."* → Session variable set by the app inside each transaction + `CURRENT_USER()` recorded alongside; changes without an actor are rejected (M2).
5. *"Synthetic data proves nothing."* → Agreed; limitations documented; query set separated from indexed narratives; labels and method published.
6. *"Both members must explain the database."* → See §6.

---

## 6. Roadmap (ordered; each ends with a verified status report)

> **Status at Milestone 6 (2026-11-03):** M1–M5 **Verified** (`scripts/verify-all.sh`, `docs/evidence/`). M4's
> evaluation harness was **Executed on a smoke set only** at that date; the registered evaluation on 24 team-written,
> frozen queries was run once on 2026-11-05 (`eval/README.md`, `docs/evidence/eval-queries.txt`). M6: final ER (generated, `docs/ER.md`) and architecture diagrams, final demo runbook
> (`docs/DEMO.md`), measured resume bullets (`docs/RESUME_BULLETS.md`) and a **fresh-checkout** install test on the
> development machine — a clean-machine / Docker install is still **not verified**. The table below is the original plan.

| Milestone | Contents | Exit evidence |
|---|---|---|
| **M1 ✔** | Foundation + vertical slice | This document, tests, spike output |
| **M2** | Migration 0002+: transition matrix + `BEFORE UPDATE` trigger (valid transitions only; manager-only reopen; `resolved_at` coherence + CHECKs); `AFTER UPDATE` audit trigger (only on real change; actor via session variable); audit tables immutable (app account has no UPDATE/DELETE; FK `RESTRICT`, soft-archive instead of delete); `Incident_Assignment_History`; `Incident_IOC.review_status/reviewed_by/reviewed_at`; `close_incident` and `reassign_incident` procedures; analytic views (severity×status, workload incl. unassigned/zero-incident analysts, MTTR, recurring IOCs, trend); EXPLAIN-driven index review; DDL demo incl. DROP; 150–300 incident synthetic seed | Tests on real MySQL: invalid transition rejected, no-op update writes no history, rejected + successful closure, successful reassignment + **forced rollback** leaves audit consistent |
| **M3** | Auth (argon2/bcrypt, sessions, rate limiting), RBAC, incident APIs, IDOR tests (analyst changes the id in a request) | HTTP-level tests with real DB |
| **M4** | Outbox + worker, hybrid ranking (documented, normalised, no double counting), lexical fallback, held-out evaluation (P@k, Recall@k, MRR; keyword vs vector vs hybrid, **same candidate set and cut-offs for all three**) | Reproducible `npm run eval`, honest results |
| **M5** | UI workflows, audit timeline, correlation page with degraded states, analytics | Real end-to-end flows |
| **M6** | Clean-machine install test, final ER + architecture diagrams, demo script, resume bullets from measured facts only | Another student can run it |

### Mapping to the four agreed phases

M1–M6 come from section 13 of the master prompt and are kept only as internal milestones.

| Agreed phase | Contains |
|---|---|
| 1. Database foundation and backend | M1 (+ review follow-up) and M2 |
| 2. Functional application and security | M3 and the incident-management UI/workflows from M5 |
| 3. Hybrid intelligence | M4 and the correlation UI |
| 4. Integration and polish | M6 |

Team split suggestion (so both members have genuine database commits): member A owns schema, triggers, procedures, transactions, analytic SQL, EXPLAIN; member B owns embedding/Qdrant, outbox worker, ranking, evaluation; both write DB tests and review each other's SQL. **Commit under your own identities; I created no git history.**

---

## 7. Known risks / accepted exceptions

- **Dependencies:** production `npm audit` is now **0 critical, 0 high, 5 moderate** (one install-time-only chain). Per-advisory reachability analysis, the patched overrides, and the raw JSON are in [`DEPENDENCY_AUDIT.md`](../DEPENDENCY_AUDIT.md) and `docs/evidence/`.
- **Model provenance:** unresolved. The weights come from a third-party npm repackaging because Hugging Face is unreachable from the build workspace. Hashes are pinned and re-verified at load; upstream verification is a required step before publishing any evaluation (`docs/MODEL.md`).
- **Docker Compose** is written (MySQL pinned to 8.0.46, `--skip-log-bin`) but **not run** here. The native-binary path was run.
- **Independent reproduction:** an external reviewer could not complete `npm install` in their environment. Raw logs from the environment that did run everything are in `docs/evidence/`.
- Decisions still open: ADR-1 (cross-incident visibility). Decided but not yet built: ADR-2, ADR-4, ADR-5 (outbox part).
