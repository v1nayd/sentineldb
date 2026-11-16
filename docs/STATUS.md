# Detailed status, full command list and known limits

> This page used to be the top of the README. It was moved here so the README can stay short and simple.
> It is the long, exact version: every claim says whether it was only written, run, or checked by an automated test.


> **Phase 2, Milestone 6.** All data is **synthetic**. Nothing here is a real incident, indicator or organisation.
> Phase 1 (submitted) is preserved untouched in [`phase1/`](../phase1/) (hashes in `docs/phase1.sha256`).

SentinelDB helps SOC analysts answer "have we seen something like this before, and what did we do?" by combining
**MySQL** (authoritative incidents, IOCs, assets, audit) with **Qdrant** (semantic retrieval over incident narratives).
Similarity alone is not evidence of relatedness, so the target design re-ranks vector candidates with relational
evidence (shared IOCs/assets, severity, recency) and explains the ordering. See [`docs/archive/PHASE2_AUDIT.md`](archive/PHASE2_AUDIT.md)
for the honest audit, compliance matrix and roadmap, and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the design.

## Status (nothing is listed as done unless it was run)

| Capability | Status |
|---|---|
| Phase 1 schema reproduced by `db/migrations/0001` | **Verified** (catalog comparison test) |
| Migration runner (ordered, checksummed, idempotent); migrations, resets and seeds share one schema lock | **Verified** (tests, incl. concurrent resets and lock release on failure) |
| Local embeddings (MiniLM-L6-v2), spec fingerprint over actual model bytes, integrity check vs manifest | **Verified** (tests + independent implementation, cosine 1.000000) |
| Qdrant layer: fingerprinted collection, vector + payload-identity validation, idempotent upsert, minimal payload, full `reconcile()` | **Verified** (tests, real Qdrant) |
| Least-privilege runtime DB account: column-level grants incl. no admin creation / role promotion, exact privilege-matrix test, separate test account | **Verified by executing SQL as that account** (`tests/grants.test.ts`) |
| MySQL → Qdrant → MySQL vertical slice (`npm run spike`) | **Executed** (smoke test, not an evaluation) |
| Health endpoint (200 / 503 / recovery) | **Executed** manually; not yet an automated test |
| Lifecycle state machine (`Status_Transitions` + `BEFORE UPDATE` trigger), role/assignee rules, `resolved_at`/`updated_at`/`narrative_version` maintained by the DB, CHECK constraints for impossible states | **Verified** (`tests/lifecycle.test.ts`; mutation-checked) |
| Audit trail: status history incl. the `NULL -> open` origin row, assignment history, evidence history; written only by triggers, only on a real change, immutable even for the privileged account; actor + DB account + source recorded | **Verified** (`lifecycle`, `evidence`, `actor-context` tests; integrity queries) |
| `close_incident` (IOCs reviewed + asset impact described), `transition_incident`, `reassign_incident`, `archive_incident`; atomic alone, savepoint-composable inside a caller's transaction; forced-rollback and row-lock concurrency tests | **Verified** (`tests/procedures.test.ts`) |
| Session-context safety (ADR-7): `withActor()` and the four required tests on a one-connection pool | **Verified** (`tests/actor-context.test.ts`) |
| Analytic views + 15 report queries (HAVING, subqueries, window functions); each view checked against an independent TypeScript computation | **Verified** (`tests/analytics.test.ts`) |
| EXPLAIN-driven index review on a 50,000-incident scaled copy (2 indexes added, 1 dropped, 1 candidate rejected on evidence) | **Executed** (`docs/INDEXING.md`, `docs/evidence/explain.txt`); timings are relative, on synthetic data |
| DDL demo covering CREATE / ALTER / DROP | **Verified** (`tests/ddl-demo.test.ts`, `docs/evidence/ddl-demo.txt`) |
| 240-incident synthetic dataset replayed through the real lifecycle (campaigns, cross-family chains, reopenings, handovers, archived incidents); deterministic generator; labels kept outside the database | **Verified** (`tests/seed-demo.test.ts`) |
| Data dictionary generated from the live catalog | **Executed** (`docs/DATA_DICTIONARY.md`) |
| Authentication: scrypt passwords, server-side sessions (token hash only in MySQL, 8 h / 30 min idle, revocation), login rate limiting from an append-only log, CSRF origin check | **Verified** (`tests/api-auth.test.ts`; mutation-checked) |
| Roles + visibility option A at the HTTP boundary; 404 for out-of-scope ids on every incident endpoint (IDOR); strict bodies (no mass assignment); password hashes never returned | **Verified** (`tests/api-access.test.ts`; mutation-checked) |
| 22 API routes (incidents, lifecycle, evidence, notes, assets, users, analytics) — reference: [`docs/API.md`](API.md) | **Verified** (`tests/api-workflow.test.ts`, `tests/route-structure.test.ts`) |
| Account rules in the database: no Users writes / no hash reads for the runtime account, account procedures, last-admin rule (concurrency-tested), deactivation revokes sessions, account audit | **Verified** (`tests/accounts.test.ts`, `tests/grants.test.ts`) |
| Built app served by `next start` (production mode) answers the same way | **Executed** (`npm run e2e:smoke`, 13 checks) |
| Transactional outbox (jobs written by triggers in the changing transaction) + worker (`FOR UPDATE SKIP LOCKED`, version fences, retries with backoff, stale-lock takeover) + repair via reconciliation | **Verified** (`tests/sync.test.ts`, `tests/sync-failure.test.ts`; mutation-checked) |
| Explainable hybrid ranking (text + shared IOCs + shared assets), visibility filter after retrieval, labelled lexical fallback (FULLTEXT) — [`docs/RANKING.md`](RANKING.md) | **Verified** (`tests/correlate.test.ts`; mutation-checked) |
| Evaluation harness: keyword vs vector vs relational vs hybrid, same candidates and cut-offs, P@5/P@10/R@10/MRR — [`eval/README.md`](../eval/README.md) | **Executed**: smoke set, and one registered run on 24 queries written by a teammate (2026-11-05; results and caveats in `eval/README.md`, `docs/evidence/eval-queries.txt`) |
| Web UI (Next.js server components + small client islands, no UI framework added): sign-in, incident list with filters/paging, incident detail (lifecycle actions, IOC review, asset impact, notes, trigger-written audit timeline, explained similar incidents), report-with-similarity-check, free-text similarity search, admin analytics dashboard, users, assets, index-sync page; light + dark theme | **Verified**: 8 UI checks in `npm run e2e:smoke` (redirects, visibility, 404 for out-of-scope and admin pages) + a real-browser interaction check (`scripts/ui-browser-check.mjs`, `docs/evidence/ui-browser-check.txt`) |
| Final diagrams: ER diagram and data dictionary generated from the live catalog ([`docs/ER.md`](ER.md), [`docs/DATA_DICTIONARY.md`](DATA_DICTIONARY.md)); as-built architecture ([`docs/ARCHITECTURE.md`](ARCHITECTURE.md)) | **Executed** (`npm run db:dictionary`) |
| Final demo runbook ([`docs/DEMO.md`](DEMO.md)); resume bullets from measured facts only ([`docs/RESUME_BULLETS.md`](RESUME_BULLETS.md)) | **Written** (demo flow checked against the live system) |
| Install from a fresh checkout (only files a clone contains; `npm ci` → model setup → migrations → seed → worker → 230 tests → build → e2e) | **Executed** on the development machine (`docs/evidence/fresh-checkout.txt`). The same steps were repeated with Docker Compose in a fresh copy (`docs/evidence/docker-run.txt`). No log from a separate physical computer is stored |
| `docker-compose.yml` (MySQL 8.0.46 + Qdrant 1.19.2) | **Executed** (2026-11-16): stack healthy, migrations, grants, seed, worker (index in sync) and integrity checks pass; full suite 230 of 230. The run found an intermittent deadlock bug in the sync worker (`tests/sync.test.ts`, `four workers in parallel…`), now fixed in `src/lib/sync.ts` (40 of 40 repeated runs pass). Log and analysis: `docs/evidence/docker-run.txt` |
| Cross-incident visibility policy for analysts | Option A (strict) **implemented**; options B/C remain a team decision (`docs/DECISIONS.md` ADR-1) |
| Evaluation of the ranking on held-out queries | **Executed once** (24 frozen queries, synthetic data): hybrid best on queries with IOCs/assets but no difference is statistically significant; relational-only was ahead on some campaign metrics. The query writer's blindness statement is still to be recorded (`eval/README.md`) |

Raw outputs of the last full verification run: [`docs/evidence/`](evidence/). Review follow-ups: [`docs/archive/REVIEW_RESPONSE_M1.md`](archive/REVIEW_RESPONSE_M1.md), [`docs/archive/REVIEW_RESPONSE_M1_FINAL.md`](archive/REVIEW_RESPONSE_M1_FINAL.md).

## Prerequisites

Node ≥ 22, MySQL 8.0.x, Qdrant 1.19.x (server) — via Docker *or* native binaries.

## Quick start — native binaries (this is the path that was actually run)

```bash
cp .env.example .env            # replace every "replace-me-*" value (letters/digits only)
npm ci
npm run model:setup             # installs + sha256-verifies the embedding model (docs/MODEL.md: provenance caveat)
./scripts/bootstrap-db.sh       # databases + 3 accounts (migrator, app, app_test); needs a root MySQL shell
# MySQL must allow non-SUPER trigger/procedure creation:  SET PERSIST log_bin_trust_function_creators = 1;  (or run with --skip-log-bin)
./scripts/qdrant-native.sh /path/to/qdrant &   # Qdrant 1.19.2 server binary from github.com/qdrant/qdrant/releases
npm run db:reset                # drop + recreate dev schema, apply migrations
npm run db:grants               # REVOKE ALL + least-privilege per-table grants for the runtime/test accounts (also rebuilds the *_test schema)
npm run db:seed -- demo         # ~240 synthetic incidents replayed through the lifecycle (empty database only); or `-- spike` for 12
npm run sync:worker -- --once    # outbox worker: embed + index everything queued (≈ 25 s for the demo seed); without --once it keeps polling
npm run db:reports -- integrity   # audit-trail checks (must end with PASS)
npm run db:reports -- analytics   # the analytic reports
npm run db:ddl-demo              # CREATE/ALTER/DROP demonstration; leaves no trace
npm run db:explain               # EXPLAIN review on a scaled scratch schema -> docs/evidence/explain.txt
npm run spike                   # (needs `db:seed -- spike`) vertical slice + full reconciliation; exits non-zero on failure
npm run eval -- eval/smoke-queries.json   # evaluation harness (smoke set; the team writes the real file from `npm run eval:pack`, see eval/README.md)
npm run dev:logins              # random passwords for one admin + one analyst of the seed, printed once
npm test                        # 230 tests against real MySQL + Qdrant (as the test account, on *_test schema / *_test collection)
npm run verify:embedding        # independent cross-check of the embedding pipeline (python3 needed)
./scripts/verify-all.sh         # everything above + build + audit; raw output -> docs/evidence/. Reports functional, integrity and security-audit results SEPARATELY, and lists what it cannot verify
npm run build && npm start      # UI + API on http://localhost:3000 (sign in with npm run dev:logins); API: docs/API.md
npm run e2e:smoke               # after a build: 21 checks (API + UI) through a real `next start` (test schema)
node scripts/ui-browser-check.mjs <email> <password> <incident id>   # optional: real-browser UI check (Edge/Chrome)
# Live demo (docs/DEMO.md): the database's rules as the runtime account, then the API with curl
mysql -h127.0.0.1 -P3307 -u sentinel_app -p --force --table sentineldb < db/demo/live_demo.sql
bash scripts/demo-api.sh '<analyst password>' '<admin password>'   # passwords from dev:logins; needs npm run dev
```

## Quick start — Docker

Run from **Git Bash** on Windows (PowerShell's `bash` may be WSL, which breaks `db:grants`).

```bash
cp .env.example .env
# In .env: set real passwords, and
#   MYSQL_ROOT_CMD="docker compose exec -T mysql mysql -uroot -p<the SAME value as MYSQL_ROOT_PASSWORD>"
# If port 3306 or 6333 is taken, change MYSQL_PORT, and QDRANT_PORT together with QDRANT_URL.
docker compose up -d
npm ci && npm run model:setup && ./scripts/bootstrap-db.sh && npm run db:reset && npm run db:grants && npm run db:seed -- demo && npm run sync:worker -- --once
```

The MySQL root password is fixed when the container first creates its data volume. If you change `MYSQL_ROOT_PASSWORD` later, run `docker compose down -v` first (this deletes the container's data).

## Layout

```
phase1/            submitted Phase 1 files (do not edit)
db/migrations/     versioned SQL (0001 = Phase 1 baseline ... 0015; see docs/DATA_DICTIONARY.md, docs/ER.md)
db/seed/           synthetic seed data (empty-database baseline)
db/grants.sql.tpl  least-privilege grants for runtime accounts
src/lib/           env, db, migrate, embedding, qdrant
src/app/           Next.js: (app)/ UI pages, login/, api/ route handlers
scripts/           migrate, seed, spike, bootstrap, setup-model, verify/ (embedding cross-check)
tests/             vitest, real MySQL + Qdrant (no mocks for database behaviour)
eval/              evaluation protocol, query-file template, harness smoke set
docs/              audit + roadmap, decisions (ADRs), architecture, model provenance, dependency audit, evidence/
```

## Data & ethics

Real incident data is confidential; this project uses invented narratives and documentation-reserved identifiers
(RFC 5737 IPs, `.example`/`.invalid` domains). Results on synthetic data demonstrate the mechanism, not production performance.

## Known limitations (Milestone 2)

- The 240-incident dataset is synthetic and written by one author together with its ground-truth labels. It demonstrates mechanisms; it is **not** an evaluation by itself; the evaluation uses separately written, pre-registered queries (`eval/README.md`).
- Index timings come from one Windows laptop on uniformly generated data: trust the relative differences, not the milliseconds.
- The database records the actor the trusted application *asserts* beside the real DB account; it cannot authenticate end users (ADR-3, M2 note 9). Privileged DDL access can drop the audit triggers (M2 note 10).
- Production `npm audit`: 0 critical / 0 high / 0 moderate (2026-10-28); see `docs/DEPENDENCY_AUDIT.md`. New advisories appear over time: re-run it.
- Embedding weights came from a third-party npm repackaging; verify per `docs/MODEL.md`.
- Production mode needs **HTTPS** (`__Host-`/`Secure` cookies; browsers exempt only `localhost`). Do not expose this build beyond localhost.
- Per-IP login limiting works only behind a reverse proxy (`TRUST_PROXY_HEADERS=true`); without one, the per-account and global limits apply.
- Run on Windows 11 with MySQL 8.0.46 (binary logging **off**) and Qdrant 1.19.2, both natively and with Docker Compose. With binary logging on, MySQL needs `log_bin_trust_function_creators = 1` (see the Quick start above); that setup was not part of our runs.
