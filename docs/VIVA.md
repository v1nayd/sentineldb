# Viva guide: what is done, how, why, where

**Status in one line (updated at M6):** MySQL done · vector database (Qdrant) done, kept in sync by an outbox + worker · hybrid ranking done · UI done · login + roles done · evaluation harness done, **evaluation run once on 24 team-written queries (2026-11-05; see `eval/README.md`)**. The sections below were written at M3; the UI and ranking are described in `docs/DEMO.md`, `docs/RANKING.md` and ADR-10/11.

Run everything from `sentineldb/` in Git Bash. Setup before the viva: [DEMO.md](DEMO.md) section 0.

## Show order (≈ 12 minutes)

| # | Criterion | Show | Time |
|---|---|---|---|
| 1 | SQL database | open `db/migrations/` + [DATA_DICTIONARY.md](DATA_DICTIONARY.md), then `mysql … < db/demo/live_demo.sql` | 5 min |
| 2 | Vector database | `npm run demo:vector -- "<a sentence the examiner gives you>"` | 2 min |
| 3 | Operations + login | `bash scripts/demo-api.sh '<aisha pw>' '<priya pw>'` | 3 min |
| 4 | Analytics / indexes | `npm run db:reports -- analytics`, [INDEXING.md](INDEXING.md) | 2 min |

---

## 1. SQL database: MySQL 8.0

**What.** 17 tables, 7 views, 38 triggers, 19 stored procedures/functions, built by 14 numbered migrations. Core tables from Phase 1: Users, Incidents, IOCs (indicators: IP, domain, hash, e-mail, URL), Assets, the M:N links Incident_IOC and Incident_Asset, Notes, Playbooks, Incident_Playbook, Incident_Status_History. Added in Phase 2: Status_Transitions, assignment / evidence / account history, Sessions, Auth_Events, schema_migrations.

**How.**
- **Keys and constraints:** PK, FK, UNIQUE and CHECK. For example, an incident can't be resolved before it was created, and `uq_iocs_type_value` stops the same indicator being stored twice. The schema is in 3NF.
- **State machine:** the allowed status moves are rows in `Status_Transitions`. A BEFORE UPDATE trigger looks each move up and refuses anything else with `SDB10`. It also fills `resolved_at` and `updated_at` itself.
- **Audit:** AFTER triggers write the status, assignment and evidence history, but only on a real change. Each history row records:
  - who acted: `@sentinel_actor`, set by the app;
  - which database account ran it: `USER()`;
  - the source and the time.

  History rows can't be edited or deleted, by any account.
- **Procedures:** status changes go through `transition_incident`, `close_incident`, `reassign_incident` and `archive_incident`. They are SQL SECURITY DEFINER and lock the row `FOR UPDATE`.
  - `close_incident` refuses while any IOC is unreviewed or any asset has no impact description (`SDB12`).
- **Transactions:** a reassignment changes the assignee, writes the history row and adds a handover note, all or nothing. Tests force a failure and check that the rollback leaves no trace; the live demo shows a ROLLBACK.
- **Least privilege:** the app's database account has only per-table and per-column grants. It cannot:
  - read password hashes;
  - set a status directly;
  - delete an incident or any audit row.
- **Analytics:** 6 views and 15 report queries using GROUP BY, HAVING, subqueries, EXISTS / NOT EXISTS, self-joins and window functions.
- **Indexes:** chosen with EXPLAIN on a scaled copy with 50,000 incidents. Two were added, one dropped and one rejected.
- **DDL demo:** CREATE, ALTER, DROP, CHECK, INDEX, VIEW, RENAME and TRUNCATE.

**Why.**
- The rules live in the database, so every path obeys them: the app, direct SQL, seed scripts and future code.
- We tested our own Phase 1 schema first. It allowed open → closed directly, forged audit rows, and audit history deleted by CASCADE ([PHASE2_AUDIT.md](archive/PHASE2_AUDIT.md) D1–D9). Phase 2 fixes each one.
- MySQL because Phase 1 was MySQL, and it has triggers, procedures, column-level grants and row locks.

**Where.**

| What | File |
|---|---|
| Schema changes | `db/migrations/0001…0014` |
| Grants | `db/grants.sql.tpl` |
| Report queries | `db/reports/analytics.sql` |
| DDL demo | `db/demo/ddl_demo.sql` |
| Lifecycle tests | `tests/lifecycle.test.ts` |
| Procedure tests | `tests/procedures.test.ts` |
| Grant tests | `tests/grants.test.ts` |

**Show.**
- `mysql -h127.0.0.1 -P3307 -u sentinel_app -p --force --table sentineldb < db/demo/live_demo.sql`
- `npm run db:ddl-demo`
- `npm run db:reports -- analytics`

## 2. Vector database: Qdrant 1.19

**What.** One vector per incident narrative: 384 numbers from the `all-MiniLM-L6-v2` model, compared by cosine similarity. You give a new incident description and get the most similar past incidents, even when they share no keywords.

**How.**
1. Read the narrative from MySQL.
2. Embed it locally with transformers.js on the CPU.
3. Upsert it into Qdrant: the point id is the incident id; the payload holds a hash of the text and the model's fingerprint.
4. To search, embed the query and ask Qdrant for the top 5 ids.
5. Load those rows from MySQL and check each vector's hash, so a vector built from an older narrative shows as STALE.

`reconcile()` compares every id in both stores and reports missing, orphaned, stale or incompatible vectors.

**Why.**
- Similarity of meaning can't be expressed with B-tree or FULLTEXT indexes. MySQL 8.0 has no vector type or similarity index.
- Qdrant holds **derived data only**: no text, just ids. It can be wiped and rebuilt from MySQL, and MySQL stays the single source of truth.
- The model runs locally, so incident text never leaves the machine.
- Honest limit: similarity is not evidence. In one test query an unrelated incident outranked a related one. That's why Milestone 4 re-ranks hits using shared IOCs and assets from MySQL.

**Where.**

| What | File |
|---|---|
| Embedding | `src/lib/embedding.ts` |
| Model fingerprint | `src/lib/embedding-spec.ts` |
| Qdrant wrapper | `src/lib/qdrant.ts` |
| Reconcile | `src/lib/reconcile.ts` |
| Demo script | `scripts/demo-vector.ts` |
| Model provenance | [MODEL.md](MODEL.md) |

**Show.** `npm run demo:vector -- "Several staff got an email from IT asking them to re-enter their password"`. Better still, let the examiner type a sentence.
- The first run after a reset embeds 228 narratives (≈ 25 s) and then prints `IN SYNC`.
- The top hits are phishing incidents, with scores around 0.63–0.69.

## 3. Implementation: operations through the API

**What.** 22 JSON API routes. They cover:
- incidents: list with filters and keyword search, create, edit, detail with history;
- status changes: transition, close, reassign, archive;
- notes;
- linking and unlinking IOCs and assets, and reviewing IOCs;
- asset inventory;
- user administration;
- analytics.

The full list is in [API.md](API.md).

**How.**
- Next.js route handlers, each wrapped by `api()`. It checks the session, the role and the CSRF origin, and maps database rule codes (SDBxx) to HTTP statuses.
- Inputs are validated by strict zod schemas.
- The SQL is hand-written and parameterised through `mysql2`; every write runs inside `withActor()`, which sets the acting user, opens a transaction and always clears the variable afterwards.

**Why.**
- No ORM, because the logic is in triggers and procedures that an ORM would hide.
- Strict schemas reject unknown fields, so nobody can set `status` or `assigned_to` through an edit (no mass assignment).

**Where.**

| What | File |
|---|---|
| Routes | `src/app/api/**/route.ts` |
| Handler wrapper | `src/lib/http.ts` |
| Repository code | `src/lib/repo/incidents.ts`, `src/lib/repo/admin.ts` |
| Acting-user helper | `src/lib/actor.ts` |
| Workflow tests | `tests/api-workflow.test.ts` |

**Show.** `bash scripts/demo-api.sh '<aisha pw>' '<priya pw>'`, with `npm run dev` running.

## 4. Login, roles, visibility

**What.**
- Login and logout, and changing your own password.
- Two roles, analyst and admin.
- Analysts see only incidents they reported or are assigned to. Anyone else's incident id answers **404**, so ids can't be probed (IDOR).

**How.**
- **Passwords:** scrypt from Node's standard library, with a random salt.
- **Sessions:** server-side. The cookie holds a random token and MySQL stores only its SHA-256 hash. Sessions expire after 8 hours or 30 minutes idle, and are revoked on logout, deactivation or a password change.
- **Login limits:** 5 failures per account per 15 minutes, and 100 per minute overall, counted in the append-only `Auth_Events` table.
- **Accounts:** account changes go only through procedures. The database refuses to remove the last active admin.

**Why.**
- Sessions instead of JWTs, because a JWT can't be revoked early, and deactivating someone must take effect immediately.
- Hashes are unreadable to the app's database account, so an SQL-injection bug can't dump them.
- 404 rather than 403, so the answer doesn't reveal that an incident exists.

**Where.**

| What | File |
|---|---|
| Password, session and login code | `src/lib/auth/password.ts`, `session.ts`, `login.ts` |
| Visibility rule | `src/lib/visibility.ts` |
| Account tables, triggers, procedures | `db/migrations/0012`–`0014` |
| Tests | `tests/api-auth.test.ts`, `tests/api-access.test.ts`, `tests/accounts.test.ts` |

## 5. UI: not done

Say it plainly: there are no screens yet, only the API. Every operation a UI needs already exists and is tested at the API level. Milestone 5 builds the screens on top of the API: incident list and detail, status buttons, audit timeline, similarity search, analytics dashboard. `src/app/page.tsx` is only a placeholder.

## 6. Dataset and testing

- **Dataset:** 240 synthetic incidents.
  - Each is inserted as open and then moved by the real procedures, so the triggers write genuine history.
  - There are 12 attack families, campaigns sharing indicators, and reopened or archived cases.
  - All IPs and domains are documentation-reserved.
  - Where: `scripts/seed/demo.ts`, `db/seed/demo_seed.sql`.
- **Tests:** 189 tests on real MySQL and Qdrant, plus 13 end-to-end checks on the built server.
  - Protections were broken on purpose to check that the tests catch it.
  - `./scripts/verify-all.sh` re-runs everything and writes [evidence/SUMMARY.txt](evidence/SUMMARY.txt).

## Likely questions

| Question | Answer |
|---|---|
| Why two databases? | MySQL for facts, constraints and transactions; Qdrant for similarity of meaning, which SQL indexes can't do. Qdrant holds only rebuildable, derived data. |
| Why not PostgreSQL + pgvector? | Phase 1 was MySQL, and MySQL 8.0 has no vector index. pgvector would also be valid; our cost is keeping two stores in sync (reconcile now, a sync worker in M4). |
| Why not MongoDB? | The data is relational: M:N links, foreign keys, multi-row transactions and audit rules. A document store would push those rules into application code. |
| What if Qdrant is down? | The health endpoint reports 503. MySQL keeps working, and M4 adds a keyword fallback that is clearly labelled as such. |
| What if the two stores disagree? | Each vector stores a hash of the text it was built from. `reconcile()` reports missing, orphaned or stale vectors, and stale hits are marked. |
| How is SQL injection prevented? | Parameterised queries only, multiple statements disabled, and least-privilege grants that limit the damage of any bug. |
| How does a trigger know the user? | MySQL only knows the DB account. The app sets `@sentinel_actor` inside each transaction; the trigger stores it next to `USER()` and refuses writes without it (SDB01). |
| What ACID property does the reassignment show? | Atomicity: the three changes commit together or roll back together. Row locks give isolation for close and for the last-admin rule. |
| Normal form? | 3NF. M:N relationships are separate junction tables, and there are no repeating groups or transitive dependencies. |
