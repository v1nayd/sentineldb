# Design decisions (resolve BEFORE Milestone 2 code)

Status legend: **Implemented+tested** · **Decided (to build)** · **OPEN — team decision**.

---

## ADR-1 · Cross-incident visibility for analysts — **Option A implemented + tested (M3); options B/C remain open**

**In force since M3 (team said "go" with option A as the working default): the original written policy.** Analysts see only incidents they reported or are assigned to; managers/admins see all. The policy lives in one function, `src/lib/visibility.ts` (`incidentScope`), every incident endpoint goes through it, and an out-of-scope incident answers 404 (IDOR tests: `tests/api-access.test.ts`, mutation-checked). M4's similarity search must filter its candidates through the same function.

Options, with their costs:

| | Policy | What an analyst learns about out-of-scope incidents | Cost / risk |
|---|---|---|---|
| **A (default)** | Strict | Nothing | Correlation only finds the analyst's own incidents; "have we seen this before?" is weaker for analysts. Managers still get the full picture. |
| **B** | Restricted-match indicator | "N other incidents outside your access resemble this — ask a manager" (no ids, narratives, notes, IOC values or asset names) | Still an **oracle**: existence + rough similarity can be probed with crafted narratives. Needs coarse buckets + rate limiting. |
| **C** | Explicit metadata whitelist | Named fields only (e.g. severity, status, incident family) | Requires the team to agree the list; IOC values and asset names are sensitive threat-intel and are **excluded** unless the team says otherwise. |

Regardless of the option: (1) enforcement is server-side, **after** vector retrieval, inside one `visibility policy` function so switching option is a one-place change; (2) because filtering happens after Qdrant returns candidates, the search over-fetches and states when fewer than *k* authorised results exist; (3) tests must call the API directly with modified incident ids and prove no bypass.

---

## ADR-2 · Lifecycle triggers vs. seed/historical data — **Implemented + tested (M2)**

Problem: lifecycle rules forbid inserting an incident directly as `closed`, yet the demo needs realistic closed/resolved incidents *with* audit history.

1. **Live creation always yields `open`, `resolved_at = NULL`, `created_at = now`.** Enforced twice: column-level INSERT grants (the app account cannot even name `status`, `resolved_at`, `created_at` — **implemented and tested**, `tests/grants.test.ts`) and, in M2, a `BEFORE INSERT` trigger for any other path.
2. **Historical data is replayed through the real lifecycle**, not inserted in final state: the seed inserts the incident as `open`, then issues the actual `UPDATE`/procedure calls (`investigating → contained → resolved → closed`). The triggers write the history rows, so the seed *is* an end-to-end test of the triggers.
3. **Back-dated timestamps** come from a session variable (`@sentinel_clock`) that the triggers honour **only** when the connecting account (`USER()`) is the import/migrator account. Any other account that sets the variable is ignored (tested in M2). Rules are therefore not weakened for application users.
4. Rejected alternatives: (a) one synthetic "baseline" history row per incident — loses the transition timeline that the demo and analytics (MTTR) need; (b) relaxing triggers for everyone — defeats the purpose.
5. **Seeds only populate an empty, freshly migrated database, atomically** (one transaction). "Empty" means **every** application table (list read from the live catalog, so tables added later are covered; the first version checked only Users+Incidents and let a stray Assets/IOCs/Playbooks row through). `scripts/seed.ts` refuses otherwise, naming the populated tables, and runs under the same schema lock as migrations/resets so two seeders cannot race past the check; `npm run db:reset` restores the baseline. There is no "merge into modified data" mode. **Implemented + tested** (`tests/seed-and-reset.test.ts`, incl. the partially-populated rejection path).
7. **Initial history entry — decided: yes.** Creating an incident writes `NULL → open` (actor = reporter, time = `created_at`) via an `AFTER INSERT` trigger, so every timeline starts with its origin and every later row has a predecessor (`old_status` is already nullable in Phase 1, so no schema change). Consequence for MTTR/analytics: time-to-resolve is measured from that first row, and a validation query in M2 asserts every incident has exactly one `NULL → …` first row and a contiguous chain (each row's `old_status` equals the previous row's `new_status`).
6. The M1 `spike_seed.sql` inserts final states directly. It is explicitly labelled legacy and is replaced in M2.

---

## ADR-3 · Database privileges — **Implemented+tested (baseline); extended in M2**

- Runtime account `sentinel_app` is created with **no** privileges; `scripts/apply-grants.sh` first `REVOKE ALL … FROM` it (all levels) and then applies `db/grants.sql.tpl` — per-table and per-column grants only. (MySQL privileges are additive, so a broad schema grant could never be narrowed later.)
- Consequences already enforced: no DELETE on Users/Assets/IOCs/Incidents/Notes/Playbooks; `Incident_Status_History` is SELECT-only; `status`, `resolved_at`, `assigned_to`, `reported_by` are not writable by the app; notes are append-only; no DDL, no access to `schema_migrations`, no GRANT.
- **Correction after review (M1 follow-up):** the first version granted table-wide `INSERT, UPDATE` on `Users`, so the runtime account could create an administrator or promote an analyst with plain SQL. Fixed with column-level grants (MySQL supports them; my earlier note that MySQL "cannot restrict `Users.role`" was wrong): `Users` — INSERT `(name, email, password_hash)`, UPDATE `(name, password_hash)`; `role` is not writable and, if omitted on INSERT, defaults to `'analyst'` (migration `0002`). Creating admins / changing roles / changing e-mail will be DEFINER procedures that verify the acting user (M3). `Assets` — key and `asset_type` immutable; `Playbooks` — key and `created_by` immutable; `Incident_Playbook.applied_at` is DB-clocked. The asset/playbook immutability choices are policy decisions (relaxing one is a one-line grant change).
- Tests: escalation attempts executed as the runtime-equivalent account (admin insert, role update, upsert and REPLACE tricks, identity columns, asset/playbook protected columns), plus an **exact privilege-matrix test** that reads `information_schema.TABLE_PRIVILEGES/COLUMN_PRIVILEGES` and fails if the account holds anything not on the allow-list. Mutation-checked: granting `UPDATE (role)` makes 3 tests fail.
- **What the database can and cannot enforce:** it can guarantee "no application SQL path may do X". It cannot tell an analyst from an admin (one DB account), so role-specific rules live in server code (M3). A fully compromised app server holding the credentials can still call any procedure the account may EXECUTE, in the app's name; these grants limit SQL-injection / app-bug blast radius, not stolen credentials. `Users` SELECT includes `password_hash` (login needs it): the server must never return it (M3 repository layer + test).
- **Triggers run with their DEFINER's privileges** in MySQL, so the app account needs no INSERT on audit tables; M2 triggers/procedures will be created by the migrator (definer) and the app gets only `EXECUTE` on specific procedures.
- Separate `sentinel_app_test` account: same grants, **test schema only**. Tests run as it; a test proves each account is denied the other's schema.
- Verified by executing SQL as that account (`tests/grants.test.ts`), not by inspecting the script.
- **M2 blocker found and fixed in configuration:** with binary logging on (MySQL default), a non-SUPER account cannot `CREATE TRIGGER/PROCEDURE` (error 1419, reproduced). Dev databases here run with `log_bin_trust_function_creators=1` (native: `SET PERSIST`) and the Compose file uses `--skip-log-bin`.
- Known limits stated honestly: *which app role* may edit a given row is an app-layer check (M3); removing an `Incident_IOC` link is allowed and currently unaudited → M2 decides whether association changes get audit rows.

---

## ADR-4 · Audit retention and actor attribution — **Implemented + tested (M2)**

- **Users are never deleted** (no DELETE grant; FKs from audit tables become `RESTRICT`). Leaving staff are *deactivated* (`is_active`, `deactivated_at`, M3). This replaces `ON DELETE SET NULL` on `changed_by`, which would erase who did what.
- Audit rows record: `actor_user_id` (FK RESTRICT), `actor_name_snapshot` (copied at write time), `db_account` (`USER()`), `source` (`app` / `import` / `db_direct`). The app passes the end-user id through a session variable set inside each transaction; changes with no actor from a non-import account are rejected (`SIGNAL`). MySQL cannot authenticate end users — it can only record what the trusted app asserts, alongside the real DB account.
- **Incidents are never physically deleted by the app.** M2 adds `archived_at`, `archived_by`, `archive_reason`; archived incidents leave default lists and the vector index (the reconcile predicate) but remain, with their history. The audit FK to `Incidents` changes from `CASCADE` to `RESTRICT`, so even an admin-level `DELETE` of an incident with history fails.
- Purging data is out of scope; retention period = indefinite for this project.
- Baseline migration 0001 is **not edited**; all of this ships as migration 0002+.

---

## ADR-5 · Vector identity and MySQL↔Qdrant invariants — **outbox implemented + tested (M4)**

**Implemented + tested (M1 follow-up)**
- *Identity*: `src/lib/embedding-spec.ts` fingerprints the **actual bytes** of every model file plus our own recipe (dimensions, pooling, normalisation, max tokens, truncation rule, preprocessing, implementation version). Files are re-verified against `models/MANIFEST.json` on load; a mismatch refuses to embed.
- The fingerprint names the collection (`<base>__<fp12>`) and is stamped in every payload. A changed recipe ⇒ a different collection ⇒ full rebuild, never silent mixing. A foreign vector inside the current collection makes search throw `IncompatibleVectorError`.
- The Qdrant wrapper validates every vector (length, finite numbers, unit norm) on upsert and search.
- `reconcile()` classifies **every** id across both stores as ok / missing / orphaned / stale / incompatible, so offsetting errors can't hide (test: 4 points vs 4 incidents while 1 missing + 1 orphan + 1 stale + 1 incompatible are all reported). Which incidents should be indexed is chosen from a **closed set of named policies** (`INDEXABLE_POLICIES`; today only `all`), not from a caller-supplied SQL fragment, so no future endpoint can route input into that statement; archiving (M2) adds an `active` policy.

- *Payload identity (review follow-up)*: `validatePayload()` is the single check used on write, search and reconciliation: `payload.incident_id` must equal the point id, `embedding_fp` and `model` must be current, `content_sha256` must be a sha256 digest, other fields typed. `upsertIncidentVector` refuses a mismatched id; search throws `IncompatibleVectorError` on an inconsistent point; `reconcile()` reports it as `incompatible` with a reason. Mutation-checked (deleting the id comparison fails 2 tests).
- *Configuration agreement*: `embeddingSpec()` cross-checks `models/MANIFEST.json`, the model's own `config.json` (`hidden_size`) and `tokenizer_config.json` (`model_max_length`), and the constants the code runs with (`src/lib/embedding-constants.ts`); any disagreement throws `SpecMismatchError` instead of fingerprinting a configuration the code does not use. The pinned versions of the libraries that execute the model (`@huggingface/transformers`, `onnxruntime-node`) are part of the fingerprint, and a test fails if the installed versions differ from the pins — so an upgrade forces a conscious pin change, a decision about `EMBEDDING_IMPL_VERSION`, and an index rebuild.
- *Failure semantics*: a narrative edited after indexing (or a re-index that failed) stays reported as `stale` on every reconciliation until a successful re-index replaces the point. Archived-incident handling (orphan → remove/quarantine) arrives with `archived_at` in M2; the sync worker (M4) must use reconciliation as a **recovery** mechanism, not as a substitute for reliable outbox processing.

**Implemented + tested (M4)**: migration 0015 (`Embedding_Jobs`, outbox triggers, `incident_sync_view`), worker `src/lib/sync.ts`, tests `tests/sync.test.ts`, `tests/sync-failure.test.ts`. As designed:
- Outbox ordering: each job carries `narrative_version`; a worker (a) claims at most one in-flight job per incident (`SELECT … FOR UPDATE SKIP LOCKED`), (b) re-reads the current version immediately before writing, (c) writes `narrative_version` into the payload and refuses to overwrite a payload with a higher version, (d) marks the job done only if the incident is still at that version, else re-queues. There is **no cross-system atomicity**; the reconciliation job above is the backstop for any residual race, and incidents show `pending/stale/failed` until reconciled.
- Qdrant down ⇒ jobs stay queued; search falls back to MySQL FULLTEXT, labelled as lexical.

---

## ADR-6 · MySQL trigger specifics — **Decided**

The spec's `AFTER UPDATE OF status ON Incidents` is PostgreSQL syntax. MySQL uses `AFTER UPDATE ON Incidents` and must compare `OLD.status <> NEW.status` itself (null-safe: `NOT (OLD.status <=> NEW.status)`). Required M2 tests: a no-op `UPDATE … SET status = status`, and an update of other columns only, must create **no** history row; each valid transition creates exactly one; each invalid transition is rejected and changes nothing.

---

## ADR-7 · Session context (actor, historical clock) on pooled connections — **Implemented + tested (M2)**

Actor identity and the import-only back-dating clock travel through MySQL session variables, and session variables **survive transaction end on a pooled connection**. Rules:
1. The data layer exposes one helper, `withActor(actorId, fn)`, that takes a connection, `SET`s the context, runs `fn` inside a transaction, and in a `finally` block **always** clears the variables (`SET @x = NULL`) — after success, error and rollback. Route handlers cannot obtain a pool connection any other way.
2. Triggers/procedures treat a missing actor from a non-import account as an error (`SIGNAL`), never as "unknown, proceed".
3. Required M2 tests: (a) an operation after a failed/rolled-back one on the **same physical connection** sees no stale actor; (b) with the pool limited to one connection, alternating actors attribute every audit row correctly; (c) setting the clock variable as the app account does **not** back-date anything (only the import account's value is honoured); (d) the helper clears context when `fn` throws.

## ADR-8 · Locking boundary and DDL recovery — **Implemented + tested**

- Migrations, destructive resets (`resetSchema`, `resetAndMigrate`, `npm run db:reset`, the test-schema rebuild in `apply-grants.sh`) and seeds all take the **same** named lock (`withSchemaLock`), so none interleaves with another; a second runner fails fast instead of dropping a schema under a running migration. The lock is released on failure (tested) and automatically if the connection dies. `--reset` still refuses any schema other than `sentineldb` / `sentineldb_test` and never runs in production.
- MySQL DDL auto-commits, so a migration that fails midway can leave partial objects while no `schema_migrations` row is written. Recovery in development: `npm run db:reset` (drops and rebuilds under the lock). There is no automatic down-migration; any production-like environment must restore from backup. Migration files are written so that one statement failing is obvious (small, single-purpose files).

---

## M2 implementation notes — where the design met MySQL (all discovered by running it)

1. **"Import account" without hard-coding a name.** Inside a stored routine `CURRENT_USER()` is the routine's *definer* (the migrator) while `USER()` is the account that connected. `sdb_is_import()` compares the two, so only a session connected as the migrator can honour `@sentinel_clock` (ADR-2 item 3). A procedure called by the runtime account runs as the definer but `USER()` still reports the runtime account, so its audit rows say `source = 'runtime'`. Tested both ways (`tests/actor-context.test.ts` (c)).
2. **No `@@in_transaction` in MySQL.** Procedures decide "own the transaction" vs "join the caller's" by trying `RELEASE SAVEPOINT` and catching error 1305 (`sdb_txn_active`). Consequence: called in autocommit they are atomic by themselves; called inside `withActor` they roll back only to their own savepoint (tested, incl. forced rollback of a reassignment whose last step fails).
3. **InnoDB does not fire triggers for foreign-key cascades**, so Phase 1's `ON DELETE CASCADE / SET NULL` could remove evidence or null out actors with no audit row at all. Migration 0003 turns every such rule into `RESTRICT` (test: no non-RESTRICT delete rule exists).
4. **Collation of routine literals.** Routines capture the *creating connection's* collation. mysql2's default `utf8mb4` is `utf8mb4_general_ci`, which made `sdb_role(x) <> 'admin'` fail with error 1267 against the schema's `utf8mb4_0900_ai_ci`. The pool and migrator now connect with `charset: "utf8mb4_0900_ai_ci"`; the catalog is checked in the smoke test.
5. **Text comparisons that must be case-sensitive** (narrative/title edits, no-op detection) use `COLLATE utf8mb4_bin`; otherwise a case-only narrative edit would not bump `narrative_version` although the embedding changes.
6. **Closure race found by design review, then reproduced by a test:** an IOC linked concurrently with `close_incident` could attach an unreviewed IOC to a closed incident. Fix: the closer locks the incident `FOR UPDATE`; evidence triggers read it `FOR SHARE`, so the link waits for the close and is then refused (SDB13). Mutation-checked.
7. **Evidence unlinking was unaudited** (ADR-3 follow-up) and would have let an unreviewed IOC simply be removed before closing. `Incident_Evidence_History` now records link / unlink (with the review state destroyed) / review; unlinking stays allowed but visible.
8. **Policy choices made in M2 that the team may overrule** (each is one row or one line): who may do what is in `Status_Transitions` (analysts progress their own incidents; resolved→closed, any reopen, assignment, archiving are admin-only; going back from `contained` needs a reason; reopening needs a reason); an assigned incident cannot become unassigned; a note may still be added to a *closed* incident but not an archived one; only closed incidents can be archived.
9. **What the database still cannot do** (unchanged from ADR-3): it records the actor the trusted application *asserts* next to the real DB account. A caller holding the runtime credentials can claim any user id. Closing that gap needs per-user DB accounts or a signed actor token, which is out of scope for this project.
10. **Privileged accounts can still tamper** with audit rows only by dropping the protecting triggers (DDL). The immutability triggers stop application bugs and ordinary DML, not a malicious DBA; the integrity queries in `db/reports/integrity.sql` detect inconsistent history, and a test shows they catch a forged row.

---

## ADR-9 · Authentication, sessions and account administration — **Implemented + tested (M3)**

- **Password storage:** scrypt from Node's standard library, OWASP minimum parameters (N=2^17, r=8, p=1, ~128 MiB per hash), 16-byte salt, versioned format `$scrypt$ln=..,r=..,p=..$salt$hash`; hashes made with older parameters are upgraded at the next successful login. *Why not Argon2id:* every Node binding is a native add-on with an install script; scrypt is the OWASP cheat sheet's next recommendation and adds no dependency (M3 added **zero** npm packages). *Cost:* memory per concurrent login; libuv's 4-thread pool bounds it (~512 MiB worst case).
- **Sessions, not JWTs:** a JWT cannot be revoked before it expires, and deactivation must act immediately. The cookie holds 32 random bytes; MySQL stores only SHA-256(token). 8 h absolute lifetime (set by a trigger, the app cannot extend it), 30 min idle. HttpOnly, SameSite=Lax, Path=/; in production `Secure` + `__Host-` prefix, which **requires HTTPS** (browsers make an exception only for `localhost`).
- **Password hashes are unreadable to the runtime DB account** (column-level SELECT on `Users` without `password_hash`); login reads one hash through `auth_lookup(email)` (DEFINER, exact match). This closes the M1/M2 caveat that any SQL-injection bug could dump all hashes. The DB also refuses to store anything that is not a hash of this format (SDB43), so a bug cannot store a plaintext password.
- **Account changes only through procedures** (`create_user`, `set_user_role`, `set_user_active`, `set_password_hash`) with the same rules re-checked by `Users` triggers on every path: admin-only role/status/e-mail changes; users change only their own name and password; **the last active admin cannot be demoted or deactivated** (SDB40); deactivation and password changes revoke all sessions; deactivated users cannot act (SDB02) or be assigned work (SDB42); users are never deleted (SDB41); everything is written to `User_Account_History`.
- **Login abuse:** limits are counted in MySQL from the append-only `Auth_Events` (survive restarts, shared by all app processes): 5 failures / 15 min per e-mail (locks that account, even for the right password), 100 failures / min globally. Per-IP limits need the client address, which Next.js route handlers do not expose; they are applied only behind a reverse proxy (`TRUST_PROXY_HEADERS=true`). All failures return the same 401 after the same scrypt cost (a dummy hash is verified for unknown e-mails), so the response does not reveal which e-mails exist.
- **CSRF:** SameSite=Lax plus an Origin check on every non-GET request (including login, against login-CSRF).
- **Trade-off stated openly:** an analyst can be locked out for 15 minutes by someone who knows their e-mail and fails 5 times (the price of a per-account limit). The in-memory 300 req/min budget is per process; it is a brake, not a security boundary.

## M3 implementation notes

1. The Users AFTER-UPDATE trigger first re-validated the actor with `sdb_actor()`; when an admin deactivated **their own** account the row was already inactive and the trigger rejected them. Found by the concurrency test; the AFTER trigger now only reads the actor the BEFORE trigger validated.
2. The last-admin rule's correctness comes from the trigger's `FOR SHARE` read of the admin rows; the procedures additionally lock those rows `FOR UPDATE` in one order so that two concurrent changes give one clean SDB40 instead of a deadlock. Mutation-checked: removing the procedure lock alone keeps the test green; removing both locks lets both admins deactivate themselves.
3. `SELECT *` from `Users` is now denied for the runtime account (column-level grant). Every query names its columns; the repository uses one `SAFE_USER_COLUMNS` list.

## ADR-10 · Similarity ranking and its evaluation — **Implemented + tested (M4); evaluation run once on 2026-11-05**

- Ranking `hybrid = 0.6·text + 0.3·iocs + 0.1·assets` with saturating, bounded components and no double counting
  ([RANKING.md](RANKING.md)). Weights fixed a priori and fingerprinted; not tuned on evaluation queries.
- Authorisation after retrieval in MySQL through `incidentScope()` (ADR-1 option A); archived incidents excluded on
  every path; over-fetch and an explicit note when fewer than k authorised results remain.
- Degraded mode: MySQL FULLTEXT, labelled `lexical_fallback`.
- Evaluation: keyword vs vector vs relational vs hybrid on the same candidate set (all active incidents) and the same
  cut-offs; P@5, P@10, R@10, MRR; protocol fixed in `eval/README.md` before any query exists. **Queries must be written
  by a team member who did not write the seed narratives**, then frozen and hashed. `eval/smoke-queries.json` (written
  by the code's author) only tests the harness and is labelled so by the runner.

- **Protocol version 2 (2026-11-04), before any team query existed**, after an external review. Ties use a seeded
  permutation, not incident id (ids are chronological, and mean id per family ranges from 78 to 142). Results are reported
  in three blocks, with conclusions drawn from the with-evidence block, because hybrid ties vector on text-only queries by
  construction. Copied IOCs are capped at 3 per query, carry their source incident, and are also measured with the source
  removed. Metric ceilings and R are reported. The writer sees only a generated pack with no titles or narratives (stricter
  than the review asked, since titles are template text too). Dataset, labels and code hashes are registered before a run;
  there is no git repository, so code is frozen by file hash. The ranking formula and weights did not change.
- **Result (2026-11-05):** one registered run on 24 queries by a teammate (`docs/evidence/eval-queries.txt`). On queries
  with IOCs/assets hybrid was best on all lenient metrics and never lost to vector on a query, but no comparison reached
  p < 0.05, and relational-only ranking beat hybrid on campaign P@5 and R-precision. Weights were not changed afterwards.
  Summary and caveats in `eval/README.md`. The writer's blindness statement is still to be recorded there.

## M4 implementation notes

1. **Deadlock between workers** (found by the parallel-workers test): the stale-lock recovery `UPDATE … WHERE status =
   'running'` ran inside the claim transaction and gap-locked the range of `idx_jobs_claim` that the other worker's claim
   moves rows into. Recovery now runs as its own statement, and a claim that loses a deadlock (errno 1213) is retried.
2. **Two claim protections, each a backup of the other** (mutation-checked): the locking read (`FOR UPDATE SKIP LOCKED`)
   and the fenced claim (`UPDATE … AND status = 'pending'`, then re-read by `locked_by`). Removing either one alone keeps
   the tests green; removing both makes the 4-worker test process jobs twice (detected 3 of 3 runs). `SKIP LOCKED` itself
   only affects throughput (without it, workers wait instead of skipping), so its removal is not detectable by a
   correctness test, by design.
3. **Two version fences**: a job older than the incident's current narrative never writes; a job never overwrites a
   point whose payload carries a newer `narrative_version`. After the write the version is re-read; if it moved on, the
   job is superseded and the current version re-queued if it had already been marked done (lost-update repair).
   Each fence has its own test and is mutation-checked.
4. The seed replays incidents through the triggers, so loading the demo dataset queues 228 upserts + 12 deletes and
   supersedes 12 upserts (archived incidents) with no special code path. Indexing them takes ≈ 25 s on the laptop CPU.
5. Mutation results: `docs/evidence/mutations-m4.txt` (12 runs).

## ADR-11 · User interface architecture — **Implemented + tested (M5)**

- **Reads are server-rendered** (React server components) and call the same repository functions as the API
  (`listIncidents`, `getIncident`, `analyticsOverview`…), so the visibility policy (`incidentScope`) and the session
  rules (`currentUser()` → `resolveSession`) are the same code on both paths. An incident outside your scope renders
  the 404 page, exactly like the API.
- **Writes go through the JSON API** from small client components (`fetch`, same origin), so every change passes the
  `api()` wrapper (CSRF origin check, role, strict schema, rate budget) and `withActor()`; the UI has no write path of its
  own. After a write the page re-renders from MySQL, so what the user sees is what the database accepted.
- Admin pages answer 404 to analysts (no hint they exist); admin links are not rendered for analysts.
- No UI library and no CSS framework were added (zero new dependencies): one stylesheet with design tokens, light and
  dark themes; chart colours validated for colour-vision deficiency (the score bar also uses gaps, a legend and numbers).
- Database rule errors are shown as the database phrased them, with the rule code (e.g. "cannot close: 1 IOC(s)
  unreviewed … (rule SDB12)"), so the UI never needs its own copy of the rules.
- Verification: 8 UI checks in the end-to-end smoke test against `next start`, plus `scripts/ui-browser-check.mjs`
  (headless Edge over the DevTools protocol: form sign-in, similar-incidents panel, adding a note, sign-out).
