# SentinelDB architecture (as built, Milestone 6)

```mermaid
flowchart LR
  B[Browser] -->|session cookie, same-origin fetch| N
  subgraph N[Next.js server]
    UI[UI pages: server components<br/>read via repositories]
    API[22+4 JSON API routes<br/>api(): CSRF, session, role, budget]
    V[visibility.ts<br/>incidentScope - option A]
    R[correlate.ts<br/>hybrid ranking + explanation]
    E[Embedding: MiniLM-L6-v2<br/>ONNX, in-process, CPU]
  end
  W[Sync worker<br/>npm run sync:worker]
  UI --> V
  API --> V
  API --> R
  R --> E
  N -->|runtime account: column grants,<br/>EXECUTE on procedures, withActor()| M[(MySQL 8<br/>authoritative: incidents, IOCs,<br/>assets, users, audit, outbox)]
  R -->|ids + cosine only| Q[(Qdrant 1.19<br/>derived: 1 vector per incident<br/>id + hash + version, no text)]
  M -->|triggers write Embedding_Jobs<br/>in the changing transaction| W
  W -->|claim FOR UPDATE SKIP LOCKED,<br/>version fences| M
  W -->|embed + upsert / delete| Q
  MG[Migrations 0001-0015, seeds<br/>migrator = definer account] --> M
```

Everything in this diagram exists and is tested; the evaluation of the ranking (M4) awaits team-written queries
(`eval/README.md`). Entity-relationship diagram: [ER.md](ER.md) (generated from the live catalog).

## SQL / vector boundary

| Data | Lives in | Reason |
|---|---|---|
| Users, roles, incidents, IOCs, assets, links, notes, status + assignment history | **MySQL** | Fixed structure, referential integrity, exact joins/aggregates, ACID, audit |
| One embedding per incident (384-d, cosine), payload `{incident_id, content_sha256, model, truncated, embedded_at}` | **Qdrant** | Nearest-neighbour over meaning; not expressible with B-tree/FULLTEXT |

Rules enforced by the code that exists today:
- Qdrant never stores narrative text or titles. A vector hit is only an id; every response must be built from MySQL rows (and, from M3, filtered by authorization there).
- Point id = `incident_id`, so upserts are idempotent (re-indexing 12 incidents twice leaves 12 points — tested).
- `content_sha256` of the embedded text is stored with the vector, so a vector computed from an older narrative is **detectable**.
- **Vector identity** is the embedding-spec fingerprint (hash of the actual model files + our recipe), not just "384 floats": it names the collection and is stamped in every payload; foreign vectors make search throw. See `DECISIONS.md` ADR-5. `ensureCollection()` also refuses a collection whose size/metric differs.
- Vectors are validated (length, finite, unit norm) at the Qdrant wrapper boundary.
- `reconcile()` compares **every** id across both stores (ok / missing / orphaned / stale / incompatible); a point-count comparison is not used as evidence.

## What happens when the two stores disagree (design; only the detector exists today)

| Situation | Planned behaviour (M4) |
|---|---|
| Incident created / narrative edited | Same MySQL transaction writes the row and an `embedding_job`; worker embeds and upserts; success/failure recorded; retries with backoff; idempotent by `(incident_id, narrative_version)` |
| Qdrant down | Jobs stay pending; searches fall back to MySQL FULLTEXT, **labelled "lexical fallback, not semantic"**; health endpoint already reports it (503) |
| Missing or stale vector | `reconcile()` (implemented) reports it; M4 adds `sync_status = pending/stale/failed` on the incident, excluded from "fully synchronised" counts, never silently treated as current |
| Incident archived/deleted | Delete job removes the point; reconciliation job lists Qdrant ids absent from MySQL |
| Orphan vector (no MySQL row) | Dropped from results (spike already asserts none) and queued for deletion |

## Security boundaries (current → planned)

- DB credentials only in `.env` (git-ignored); `src/lib/env.ts` validates and never echoes values.
- Three MySQL accounts: **migrator** (DDL; scripts/tests only, no GRANT OPTION), **app** (runtime) and **app_test** (same grants, test schema only). The runtime account has **per-table/column grants only** (`db/grants.sql.tpl`): no DELETE on evidence/identity tables, audit history SELECT-only, `status`/`resolved_at`/`assigned_to`/archive columns not writable (they change only via the four definer procedures of M2: `transition_incident`, `close_incident`, `reassign_incident`, `archive_incident`; triggers enforce the same rules on every path), and no INSERT/UPDATE on `Users.role`/`email` (admin creation and role changes will be definer procedures in M3). Verified by executing SQL as that account and by an exact privilege-matrix test (`tests/grants.test.ts`). See `DECISIONS.md` ADR-3.
- App pool has `multipleStatements: false`; all queries parameterised; IN-lists use server-side prepared statements.
- Health endpoint logs failure details server-side and returns only up/down.
- UI pages read through the same repository and visibility functions as the API; every UI write is an API call (ADR-11).
- Authentication (scrypt, server-side sessions), RBAC (analyst / admin), visibility option A, CSRF origin check, login rate limiting: **implemented + tested (M3)** — `docs/API.md`, `docs/DECISIONS.md` ADR-9. The runtime account cannot read `Users.password_hash` and cannot write `Users` at all.

## Reproducibility notes

- All timestamps are exchanged in UTC (`SET time_zone='+00:00'` per pooled session).
- Dependency versions are pinned (`package.json` exact versions + `package-lock.json`). Qdrant client 1.19.0 ↔ server 1.19.2 (same minor).
- Model files are hash-pinned in `models/MANIFEST.json` and verified by `npm run model:setup`.

## Milestone 2 additions (database behaviour, all tested)

```
app (withActor: SET @sentinel_actor, txn, always cleared)  ──►  CALL transition/close/reassign/archive_incident
                                                                         │ (SQL SECURITY DEFINER, row locks, savepoints)
                                                                         ▼
Incidents ──BEFORE UPDATE──► Status_Transitions check, role/assignee check, closure gate, derived columns
          ──AFTER  UPDATE──► Incident_Status_History / Incident_Assignment_History (only on a real change)
Incident_IOC / Incident_Asset ──triggers──► Incident_Evidence_History (link / unlink / review)
Audit tables + Notes: UPDATE/DELETE rejected by trigger for every account
```

Migrations 0003–0011: FK `RESTRICT`, lifecycle columns + state machine, audit tables, session functions, lifecycle triggers, evidence/audit-immutability triggers, procedures, analytic views, workload indexes. See `docs/DATA_DICTIONARY.md` (generated), `docs/INDEXING.md` and `docs/DECISIONS.md` (M2 implementation notes).

## Milestone 4 additions (MySQL → Qdrant sync and similarity search, all tested)

```
API write (withActor txn) ──► Incidents row changes ──AFTER trigger──► Embedding_Jobs (same transaction: commit or roll back together)
                                                                            │
sync worker (npm run sync:worker, or POST /api/sync)  ◄── claim: FOR UPDATE SKIP LOCKED, fenced on status='pending'
   │ re-read incident version → embed → refuse older-than-index → upsert point {incident_id, sha256, narrative_version}
   │ re-read version → done | superseded (+ requeue on lost update) | retry with backoff → failed after 5
   ▼
Qdrant (derived)         repair(): reconcile() every id → re-queue missing/stale, delete orphaned/incompatible

GET /api/incidents/:id/similar, POST /api/search/similar
   embed query → Qdrant top-100 ids ∪ incidents sharing IOCs/assets (MySQL) → filter by incidentScope() + not archived
   (MySQL) → cosine for every candidate (has_id) → hybrid score + explanation;  Qdrant/model down → FULLTEXT, labelled
```

Ranking: [RANKING.md](RANKING.md). Evaluation protocol: [../eval/README.md](../eval/README.md).
