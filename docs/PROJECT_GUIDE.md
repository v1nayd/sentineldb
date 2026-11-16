# SentinelDB: the full project guide (plain English)

This guide explains the whole project: what it is, why we built it, how it works, what tools we used, where to find
each part in the code, and what is NOT finished or NOT proven. It is written so you can read it once and then explain
it to someone else. Every number in it comes from a file in this repository (named in brackets).

All data in the project is **made up** (synthetic). There are no real incidents, people or companies.

---

## 1. The one-minute version

**SentinelDB is a database system for a security team.** When something bad happens on a company's computers (a phishing
email, a ransomware attack, a stolen password), the team writes it down as an *incident*. SentinelDB stores those
incidents and helps the team answer one question:

> "Have we seen something like this before, and what did we do?"

To answer it, the system uses **two databases that each do what they are best at**:

- **MySQL** holds the exact, structured facts: who reported the incident, its status, which computers were hit, which
  suspicious addresses (called IOCs) were found, and a full history of every change.
- **Qdrant** (a vector database) holds a "meaning fingerprint" of each incident's story, so we can find incidents that
  *mean* the same thing even when they use different words.

Then a **hybrid ranking** mixes both: how similar the stories are, plus hard evidence like "both incidents involved the
same bad website". Every result comes with a plain explanation of why it ranked where it did.

The hard part of the project is the **database work**: rules, history, permissions and keeping two databases in step.
The web page on top is only a way to use and show that work.

---

## 2. The problem and the idea

### The problem
Security teams get many incidents. A new incident is often a repeat or a cousin of an old one. If an analyst can find
the old one quickly, they can reuse what worked. But two things make this hard:

1. **Words differ.** One person writes "Files on the finance share were renamed and a note asks for payment." Another
   writes "Ransom message found after documents stopped opening." Same attack, almost no shared words. Normal keyword
   search misses it.
2. **Similar text is not proof.** Two stories can sound alike and still be unrelated. Proof is stronger when they share a
   fact: the same suspicious domain, the same infected server. A plain "similar text" search ignores facts.

### The idea
- Keep the **facts** in a normal relational database (MySQL), where rules, links and history are strong.
- Keep a **meaning index** in a vector database (Qdrant) only for the one thing tables cannot do: search by meaning.
- **Combine** them when ranking, and **show the reasons**.

### Why two databases (and not one)?
Our Phase 1 spec warned about "a second database used for no real reason". Here there is a real reason: nearest-meaning
search over text is not something normal MySQL indexes can do. And the second database is only a helper. **MySQL is the
boss.** If the two ever disagree, MySQL is right, and the system repairs Qdrant.

---

## 3. How the work was organised

| Stage | What it was |
|---|---|
| **Phase 1** (submitted) | The plan: a spec, an ER diagram and the table definitions (DDL). Kept untouched in `phase1/`. |
| **Phase 2, Milestone 1** | Foundation: rebuild the Phase 1 tables from migration files, local embedding model, Qdrant layer, safe database accounts, a first end-to-end test. |
| **M2** | Database behaviour: incident life cycle, audit history, stored procedures, analytic views, index review, a 240-incident dataset. |
| **M3** | Login, sessions, roles, and the JSON API. |
| **M4** | Keeping MySQL and Qdrant in sync (the "outbox"), the hybrid ranking, and the evaluation. |
| **M5** | The web interface. |
| **M6** | Final documents, diagrams, demo script, install test. |

The Phase 1 design is proven to be reproduced exactly by migration `0001`, using a test that compares the catalogs
[`tests/baseline-equivalence.test.ts`].

---

## 4. The tools we used, what they are, and why

| Tool | What it is (simple) | Why we chose it |
|---|---|---|
| **MySQL 8** | A classic relational database. Stores data in tables with strict rules. | The course is about DBMS. It gives us foreign keys, CHECK rules, triggers, stored procedures, transactions and views. |
| **Qdrant 1.19** | A database built to find the "nearest" vectors (lists of numbers). | Searching text by meaning needs nearest-neighbour search, which MySQL cannot do. |
| **all-MiniLM-L6-v2** | A small AI model that turns a sentence into 384 numbers (an "embedding"). Similar meanings give similar numbers. | Small, free (Apache-2.0), runs on a laptop CPU, no internet needed at runtime, no paid API. |
| **ONNX Runtime** (via `@huggingface/transformers`) | A program that runs the model inside Node.js. | Lets us run the model locally in the same app, with no Python server. |
| **Node.js 22 + TypeScript** | The language and runtime for the app code. TypeScript adds types to catch mistakes. | One language for server, scripts and tests. |
| **Next.js 16 (App Router) + React 19** | A framework for web pages and API routes. | Pages that read data on the server (fast, safe) plus small interactive parts. Only dependency for the UI; no extra UI libraries. |
| **mysql2** | The Node.js driver for MySQL. | Supports prepared statements and connection pools. |
| **zod** | A library that checks the shape of incoming data. | Rejects bad or extra fields (this blocks "mass assignment" attacks). |
| **vitest** | A test runner. | Runs our tests against the real MySQL and real Qdrant, not fakes. |
| **tsx** | Runs TypeScript scripts directly. | For our scripts (migrations, seed, worker, evaluation). |
| **scrypt** (built into Node) | A slow, safe way to scramble passwords. | Passwords are stored only as scrambled hashes. |

Exact versions are pinned in [`package.json`]. The production dependencies have 0 known vulnerabilities in the last
`npm audit` [`docs/evidence/npm-audit-prod.json`]. The number of runtime libraries is small on purpose: 8 libraries.

---

## 5. Architecture and pipeline

### 5.1 The picture

```
 Browser
   |  (session cookie)
   v
 Next.js server  ------------------------------------------------+
   |  pages (read via repositories)   JSON API routes             |
   |  visibility.ts  (who may see which incident)                 |
   |  correlate.ts   (hybrid ranking + explanation)               |
   |  embedding.ts   (MiniLM, runs inside the server)             |
   |                                                              |
   |  as the "app" database account                               |
   v                                                              v
 MySQL 8  (the boss: all facts, rules, history, job queue)     Qdrant (helper: 1 vector per incident)
   ^   |                                                          ^
   |   +-- triggers write a "job" into Embedding_Jobs  ------+    |
   |                                                         v    |
   +------------------  Sync worker (npm run sync:worker) ---------+
                        claims jobs, makes the embedding, writes to Qdrant
```

Source: [`docs/ARCHITECTURE.md`] has the same diagram as a Mermaid chart.

### 5.2 Rules about the two databases
- Qdrant **never stores the text** of an incident. It stores only a vector and a small label: the incident id, a hash of
  the text it came from, and a version number.
- A search hit from Qdrant is **only an id**. The app always loads the real data from MySQL and checks the user's
  permission there.
- The id in Qdrant equals the incident id in MySQL, so saving the same incident twice never makes a duplicate.
- Every vector is checked (right length, real numbers, unit length) before it is saved or used.

### 5.3 The three main flows

**Flow A: someone reports or edits an incident**
1. The browser calls the API (for example `POST /api/incidents`).
2. The server runs the change inside a **transaction**, using `withActor()` [`src/lib/actor.ts`] to tell MySQL which
   user is acting.
3. MySQL **triggers** run by themselves: they check the rules, set the dates and version number, write the history rows,
   and add a row to `Embedding_Jobs` (the "outbox") in the *same* transaction.
4. Either everything is saved, or nothing is.

**Flow B: the sync worker updates Qdrant**
1. The worker finds pending jobs and *claims* one (`SELECT ... FOR UPDATE SKIP LOCKED`, so two workers never take the
   same job).
2. It re-reads the incident, makes the embedding, and writes it to Qdrant. It refuses to overwrite a newer vector with
   an older one.
3. It marks the job done. If the story changed while it worked, it marks the job "superseded" and re-queues. If Qdrant
   is down, it waits and retries with growing delays, and gives up after 5 tries (status `failed`, visible in the UI).

**Flow C: someone searches for similar incidents**
1. The server turns the search text into a vector.
2. Qdrant returns the 100 closest incident ids. The server also adds every incident that shares an IOC or an asset with
   the query (found in MySQL).
3. MySQL filters this list so the user only sees what they are allowed to see.
4. For every remaining candidate the server computes the **hybrid score** and a one-line explanation.
5. If Qdrant or the model is down, it falls back to MySQL keyword search and says so clearly on screen.

---

## 6. The database (the heart of the project)

### 6.1 The tables (18)
Source of truth: [`docs/DATA_DICTIONARY.md`] (generated from the real database) and [`docs/ER.md`] (diagram).

| Group | Tables | What they hold |
|---|---|---|
| People | `Users`, `Sessions`, `Auth_Events`, `User_Account_History` | Accounts and roles, login sessions, login attempts, who changed which account |
| The incident | `Incidents` | Title, story (narrative), severity, status, who reported it, who it is assigned to, dates, version, archive info |
| Evidence | `IOCs`, `Incident_IOC`, `Assets`, `Incident_Asset` | Suspicious indicators (IP, domain, URL, file hash, e-mail), affected machines, and the *many-to-many* links between them and incidents |
| Notes | `Notes` | Analyst notes on an incident |
| Rules as data | `Status_Transitions` | The list of allowed status moves |
| History (audit) | `Incident_Status_History`, `Incident_Assignment_History`, `Incident_Evidence_History` | Every change, written by triggers, impossible to edit or delete |
| Vector sync | `Embedding_Jobs` | The outbox queue for the Qdrant worker |
| Housekeeping | `Schema_Migrations` | Which migration files have run |
| From Phase 1 | `Playbooks`, `Incident_Playbook` | Response playbooks and their link to incidents |

Why this counts as a strong design: it has several many-to-many links, tables that depend on others (history tables),
CHECK and UNIQUE rules, and real foreign keys (`ON DELETE RESTRICT`, so you cannot delete things that others depend on).

### 6.2 The incident life cycle (a state machine stored as data)
An incident moves through five statuses. The allowed moves are rows in `Status_Transitions`
[`db/migrations/0004_incident_lifecycle_columns.sql`]:

```
open --> investigating --> contained --> resolved --> closed
              ^   |             |           |            |
              |   +--> resolved-+           +--reopen----+--reopen--> investigating
              +--------- (back, needs a reason) 
```

- `open -> investigating`, `investigating -> contained`, `investigating -> resolved`, `contained -> resolved`: anyone
  assigned.
- `contained -> investigating`: needs a reason.
- `resolved -> closed`: **admin only**, and only through `close_incident`.
- `resolved/closed -> investigating` (reopen): admin only, needs a reason.

A `BEFORE UPDATE` trigger [`0007_lifecycle_triggers.sql`] refuses any move not in the table. So **even someone using raw
SQL cannot break the rule.** The same trigger fills `resolved_at`, `updated_at` and `narrative_version` by itself.

### 6.3 Rules that live in the database, not just the app
Why: an app can have bugs, or someone can connect directly. A rule inside the database cannot be skipped.

- **The closing gate** (`close_incident`): an incident can be closed only if every IOC has been reviewed and every
  affected asset has an impact description. The database answers with its own message, for example
  *"cannot close: 1 IOC(s) unreviewed, 1 asset(s) without impact description (rule SDB12)"*.
- **Who may act**: role and assignee checks inside the triggers.
- **CHECK constraints** make impossible states impossible: for example `resolved_at` must be set exactly when the status
  is resolved or closed.
- **Error codes** like `SDB01` and `SDB10` make refusals easy to recognise and test.

### 6.4 Stored procedures (11) and functions (8)
Procedures do multi-step jobs safely in one transaction: `transition_incident`, `close_incident`,
`reassign_incident` (changes the assignee, writes history and a handover note), `archive_incident`, and account
procedures (`create_user`, `set_user_role`, `set_user_active`, `set_password_hash`, `auth_lookup`). They run with
`SQL SECURITY DEFINER`, which means they have the power the plain app account lacks, but only for exactly what they do.
Helper functions like `sdb_actor()` read who is acting. Source: migrations `0006`, `0009`, `0014`.

### 6.5 Triggers (40) and the audit trail
Triggers write the history tables on every *real* change (a no-op update writes nothing). The audit tables and notes
**reject UPDATE and DELETE for every account**, even the privileged one. So the history cannot be rewritten
[`0005_audit_tables.sql`, `0008_evidence_and_audit_triggers.sql`]. Each history row records who did it, which database
account was used, and whether it came from the app or an import.

### 6.6 Views (8) for analysis
Examples [`0010_analytics_views.sql`]: `severity_status_matrix_view`, `workload_by_assignee_view`,
`mttr_by_severity_view` (mean time to resolve, from the audit trail), `monthly_trend_view`, `recurring_ioc_view`,
`incident_summary_view`, `incident_sync_view`. The Analytics page shows them. Each view was checked against a separate
calculation done in TypeScript [`tests/analytics.test.ts`]. There are also 15 report queries using HAVING, subqueries and
window functions [`npm run db:reports`].

### 6.7 Indexes, chosen by measurement
We tested on a 50,000-incident copy using `EXPLAIN ANALYZE` [`docs/INDEXING.md`, `docs/evidence/explain.txt`]:
- An analyst-queue query went from reading **1,112 rows to 225**.
- A one-month date-range query went from **51,215 rows to 2,420**.
- One planned index was **rejected** because it showed no gain.
(Synthetic data, one laptop, so the timings are relative.)

### 6.8 Permissions: least privilege
There are three MySQL accounts [`db/grants.sql.tpl`, `docs/DECISIONS.md` ADR-3]:
- **migrator**: builds tables (used only by scripts and tests).
- **app**: what the running website uses. It has **per-table and per-column** permissions only. It cannot read password
  hashes, cannot set a status directly, cannot delete audit rows, and cannot write the `Users` table at all.
- **app_test**: same as app, but only for the test database.

An exact privilege-matrix test checks this list [`tests/grants.test.ts`].

### 6.9 Migrations
15 numbered SQL files in `db/migrations/` build the database step by step. The runner [`src/lib/migrate.ts`,
`scripts/migrate.ts`] applies them in order, remembers a checksum for each, and refuses to run if an old file was changed.
Resets and seeds share a lock so two runs cannot collide.

---

## 7. Keeping MySQL and Qdrant in step: the outbox

This is the hardest engineering idea in the project, so it has its own section.

**The danger.** If the app saves to MySQL and then calls Qdrant, the second step can fail (Qdrant down, app crash).
Then the two stores disagree and nobody notices.

**The fix: a transactional outbox** [`db/migrations/0015_embedding_outbox.sql`, `src/lib/sync.ts`].
- A trigger writes a row in `Embedding_Jobs` **in the same transaction** as the incident change. Both succeed or both
  fail. The "to-do" is never lost.
- A separate worker does the slow, risky part (embedding + Qdrant) later and can retry.

Protections in the worker, each tested on purpose [`tests/sync.test.ts`, `tests/sync-failure.test.ts`]:
- **`SKIP LOCKED` claim**: two workers do not grab the same job.
- **Fenced claim**: a job can be taken only while it is still `pending`.
- **Version fence**: every job carries `narrative_version`. The worker rechecks the version before and after writing, and
  never lets an old version overwrite a new one.
- **Retry with backoff**, and `failed` after 5 attempts.
- **Stale-lock takeover**: if a worker dies, its job is picked up by another.
- **Deadlock retry**: our parallel-worker test found a real InnoDB deadlock (error 1213); we fixed it by moving stale-lock
  recovery out of the claim transaction and retrying on that error.
- **`repair()` / `reconcile()`**: compares *every* id in both stores and sorts them into ok / missing / orphaned / stale /
  incompatible. It never trusts a simple count.

We also checked that these protections matter by **breaking them on purpose** (mutation testing) and confirming the tests
fail [`docs/evidence/mutations-m4.txt`].

**Vector identity.** The collection name includes a fingerprint of the model files and our recipe (pooling, truncation,
etc.). If anything changes, a *new* collection is used instead of mixing old and new vectors silently
[`src/lib/embedding-spec.ts`, ADR-5].

---

## 8. The search ranking

Source: [`src/lib/correlate.ts`], [`docs/RANKING.md`].

For a query and each candidate incident:

| Part | Meaning | Range |
|---|---|---|
| text | `max(0, cosine similarity)` between the two story vectors | 0 to 1 |
| iocs | `min(shared IOCs, 2) / 2` | 0, 0.5, 1 |
| assets | `min(shared assets, 1)` | 0 or 1 |

**hybrid = 0.6 × text + 0.3 × iocs + 0.1 × assets**

Why built this way:
- **Text counts most**, because every incident has a story.
- **Shared IOCs are strong but rare**, so they get a big bonus that stops growing after 2 (ten shared IOCs should not
  swamp the story).
- **Shared assets are weak evidence**, because common machines (like a mail server) appear in many unrelated incidents.
  So the bonus is small and stops at 1.
- **No double counting.** An IOC marked "dismissed" (a false alarm) counts zero.
- **The weights were chosen before any test and were never tuned**, so the evaluation stays fair. Honest note: because
  the cosine values sit in a narrow band (about 0.27 to 0.76), one shared IOC (+0.15) is worth quite a lot. The weights
  are "nominal", not a true 60/40 split.

**Explainable.** Every result shows its parts and a sentence like
*"71% semantic text similarity · shares 1 IOC (docs-account35.example) · same asset fileserver-01"*.

**Security-aware.** Results are filtered in MySQL by `incidentScope()` [`src/lib/visibility.ts`] after Qdrant answers.
Archived incidents never appear. Other people's incidents never leak, even their IOC values.

**Safe fallback.** If Qdrant or the model fails, the answer is labelled `lexical_fallback` and uses MySQL FULLTEXT. It is
never passed off as "semantic".

**Freshness.** Each result shows whether its vector is up to date (`synced / pending / failed / missing`).

---

## 9. Security

| Area | What we did | Where |
|---|---|---|
| Passwords | Stored only as `scrypt` hashes; the app account cannot even read them | `src/lib/auth/password.ts` |
| Sessions | Random token; only its **hash** is stored in MySQL; expires after 8 hours, or 30 minutes idle; can be revoked | `src/lib/auth/session.ts` |
| Login guard | Rate limiting from an append-only log of attempts | `Auth_Events` |
| Cross-site tricks | CSRF check on the request origin | `src/lib/http.ts` |
| Roles | `analyst` and `admin`. Admin pages answer **404** to analysts | `currentUser/requireAdmin` in `src/lib/auth/current-user.ts` |
| Who sees what | "Option A": analysts see only incidents they reported or are assigned to. Others answer **404**, so they look like they do not exist (this blocks "IDOR" guessing of ids) | `src/lib/visibility.ts`, ADR-1 |
| Bad input | Strict zod schemas; extra fields are rejected; no mass assignment | API routes |
| SQL injection | All queries are parameterised; no multi-statement queries | `src/lib/db.ts` |
| Database powers | Per-column grants, definer procedures, immutable audit | section 6.8 |

Visibility options B and C (showing "N similar incidents exist outside your access" or a safe field list) are written down
in ADR-1 but **not chosen or built**.

---

## 10. The application (what a person sees)

All UI code is in `src/app/`. Pages that only read data are *server components* that call the same repository functions as
the API (`src/lib/repo/`). Anything that changes data is a small *client island* that calls the JSON API. No UI library was
added.

| Page | What it does |
|---|---|
| Sign in | Login, server-side session |
| Incidents | List with filters and paging |
| Report incident | Type a description; **Check for similar incidents** before filing |
| Incident detail | Timeline (history), status moves, assignment, IOC review, asset impact, notes, and **"Have we seen this before?"** |
| Search | Free-text similar search with a score breakdown bar |
| Analytics | The database views as tables and charts |
| Admin: Users, Assets, Index sync | Account control; manage assets; see outbox counts and run "Reconcile + repair" |
| Account | Change own password |

The API has about 26 routes [`docs/API.md`], for example `GET/POST /api/incidents`,
`POST /api/incidents/:id/transition`, `.../close`, `.../reassign`, `.../iocs`, `.../notes`, `GET /api/incidents/:id/similar`,
`POST /api/search/similar`, `POST /api/sync`, `/api/analytics/*`, `/api/health`. The `api()` wrapper in `src/lib/http.ts`
adds the CSRF check, session check, role check and size limits to every route in one place.

---

## 11. The data

The dataset is generated by code [`scripts/generate-seed.ts`, `scripts/seed/demo.ts`] with a fixed random seed (20261027),
so everyone gets the same data.
- **240 incidents** (228 active, 12 archived), replayed **through the real life cycle**, so the history rows are real.
- **12 attack families**: phishing, business-email fraud, ransomware, brute force, credential stuffing, macro malware,
  cryptomining, data exfiltration, web exploitation, C2 beaconing, cloud misconfiguration, DDoS.
- **Campaigns**: groups of incidents that share a main IOC. **Chains**: stories that cross families.
- The "answer key" (which incident belongs to which family/campaign) is kept in `db/seed/demo_labels.json`, **outside** the
  database, so the ranking code can never read it.

Honest limit: the same author wrote the data and its labels, from templates.

---

## 12. Testing and proof

| Check | Result | Where |
|---|---|---|
| Automated tests (real MySQL + real Qdrant) | **230 pass**, in 24 files | `tests/`, `docs/evidence/tests.txt` |
| End-to-end through the built app (`next start`) | **21 checks pass** | `scripts/e2e-smoke.ts` |
| Real-browser check (headless Edge) | Pass | `scripts/ui-browser-check.mjs` |
| Mutation checks (we broke protections on purpose) | Tests caught them | `docs/evidence/mutations-m4.txt` |
| Embedding cross-check against an independent Python version | Cosine 1.000000; it found and fixed a truncation bug | `npm run verify:embedding` |
| Dependency audit (production) | 0 vulnerabilities | `docs/DEPENDENCY_AUDIT.md` |
| One command re-runs everything | `bash scripts/verify-all.sh`: last run exit 0 | `docs/evidence/SUMMARY.txt` |
| Fresh checkout install test | Passed on the dev machine | `docs/evidence/fresh-checkout.txt` |

Tests include: running SQL *as the app's own account* to prove refusals, concurrency tests (parallel workers, last-admin
rule), forced rollbacks, and tests that call the API directly with other users' ids to prove they get 404.

---

## 13. The evaluation: did hybrid really help?

**Question.** Does adding shared IOCs/assets to meaning search rank related past incidents better than keyword search or
vector search alone?

**How we kept it fair** [`eval/README.md`]:
- The protocol was fixed **before** any evaluation query was run, and it records hashes (query file, data, labels, code)
  so nothing can change quietly.
- The 24 queries were written by a teammate who did not write the data, using only a generated pack of family names, campaign
  labels, IOCs and assets (no titles, no stories) [`npm run eval:pack`].
- Four methods were scored on the same 228 candidates: keyword, vector, relational-only, and hybrid.
- Ties are broken by a seeded shuffle, never by incident id.
- It was run **once**.

**Results** (12 queries that carry IOCs/assets) [`docs/evidence/eval-queries.txt`]:

| Method | P@10 | MRR |
|---|---|---|
| keyword | 0.550 | 0.710 |
| vector | 0.725 | 0.850 |
| relational-only | 0.575 | 1.000 |
| **hybrid** | **0.825** | **1.000** |

Finding the *rest* of a campaign (source incidents removed), recall in the top 10: hybrid **0.847**, vector 0.472,
keyword 0.285.

**How to read this honestly**
- Hybrid is best on queries that carry evidence, and it never lost to vector on any single query.
- On text-only queries hybrid **equals** vector (there is nothing to add), and keyword vs vector is about even.
- Relational-only was ahead of hybrid on two campaign measures (P@5 and R-precision). This is expected: campaigns here
  are defined by shared IOCs.
- **No difference is statistically significant** (best p = 0.065, 12 queries per group). Say "consistent and large, not
  proven".
- One synthetic dataset; labels come from the generator, not from analysts.

(Terms: **P@10** = how many of the top 10 are truly related. **MRR** = how high the first correct answer sits. **R@10** =
the share of all related incidents found in the top 10.)

---

## 14. Gaps and limits (be upfront about these)

| Topic | Status |
|---|---|
| Real data, real analysts | Not used. Everything is synthetic. |
| Evaluation size | 24 queries, one dataset, one run, no significance. |
| Who wrote the data | Same person wrote data, labels and ranking code. Queries were written by a teammate to reduce that bias; the teammate's blindness is a team statement, not something tools can check. |
| Ranking weights | Chosen by reasoning, not tuned. Not claimed to be optimal. |
| Embedding model source | The two model files came from an npm package, not directly from Hugging Face. Their hashes are pinned and checked, but a match with the official release is **not verified** (`docs/MODEL.md`). |
| Clean machine / Docker | Run from a fresh checkout copy on the development machine, natively (`docs/evidence/fresh-checkout.txt`) and with Docker Compose (`docs/evidence/docker-run.txt`). No log from a separate physical computer is stored. |
| MySQL with binary log on | Not tested. |
| Scale and security audit | Performance beyond 50,000 synthetic incidents and any outside security audit: not done. |
| Visibility | Only option A is built. Options B and C remain open. |
| Source control | No git repository existed during the work, so there is no commit history. The team should commit under their own names. |
| Index freshness | Vectors can be briefly out of date; the screen shows "index pending" until the worker runs. |

---

## 15. Where to point in the code (code map)

| If someone asks about... | Open this |
|---|---|
| The tables and rules | `db/migrations/0001` to `0015`, `docs/DATA_DICTIONARY.md`, `docs/ER.md` |
| The status rules | `Status_Transitions` in `0004`, trigger in `0007` |
| Closing gate, reassign, archive | `0009_lifecycle_procedures.sql`, `tests/procedures.test.ts` |
| Audit trail is immutable | `0005`, `0008`, `tests/lifecycle.test.ts`, `tests/evidence.test.ts` |
| Who is acting (audit author) | `0006_session_context_functions.sql`, `src/lib/actor.ts` (`withActor`), `tests/actor-context.test.ts` |
| Reports and views | `0010_analytics_views.sql`, `src/lib/reports.ts`, `db/reports/`, `tests/analytics.test.ts` |
| Index choices | `0011_workload_indexes.sql`, `docs/INDEXING.md`, `scripts/explain.ts` |
| Safe database accounts | `db/grants.sql.tpl`, `scripts/apply-grants.sh`, `tests/grants.test.ts` |
| Login and sessions | `src/lib/auth/` (`password.ts`, `session.ts`, `login.ts`, `current-user.ts`) |
| The API wrapper | `src/lib/http.ts` (`api()`), `src/app/api/**` |
| Who sees what | `src/lib/visibility.ts` (`incidentScope`), `tests/api-access.test.ts` |
| The embedding model | `src/lib/embedding.ts`, `src/lib/embedding-spec.ts`, `models/MANIFEST.json`, `docs/MODEL.md` |
| Talking to Qdrant | `src/lib/qdrant.ts`, `src/lib/reconcile.ts` |
| The outbox and worker | `0015_embedding_outbox.sql`, `src/lib/sync.ts` (`runSync`, `repair`), `scripts/sync-worker.ts` |
| The ranking | `src/lib/correlate.ts` (`hybridScore`, `correlate`), `docs/RANKING.md` |
| The evaluation | `eval/README.md`, `scripts/eval.ts`, `src/lib/eval-metrics.ts`, `scripts/eval-pack.ts`, `docs/evidence/eval-queries.txt` |
| The data | `scripts/generate-seed.ts`, `scripts/seed/demo.ts`, `db/seed/demo_seed.sql`, `db/seed/demo_labels.json` |
| The pages | `src/app/(app)/` (incidents, search, analytics, admin, account), `src/app/_ui/` |
| All decisions and reasons | `docs/DECISIONS.md` (ADR-1 to ADR-11) |
| Running the demo | `docs/DEMO.md` |
| Proof files | `docs/evidence/` |

---

## 16. Questions people may ask, with short answers

**Why not store everything in Qdrant, or everything in MySQL?**
MySQL cannot search by meaning, and Qdrant cannot enforce foreign keys, transactions or audit rules. Each does the job it
is good at, and MySQL stays the single source of truth.

**What if Qdrant goes down?**
Edits still work, because jobs wait in the MySQL outbox. Search falls back to keyword search and says so. When Qdrant
returns, the worker catches up.

**Why triggers and procedures, not just app code?**
Rules in the database protect the data from every path, including direct SQL and future bugs.

**What is an IOC?**
"Indicator of compromise": a clue such as a bad IP address, domain, URL, file hash or e-mail address.

**What is an embedding?**
A list of 384 numbers that captures the meaning of a text. Texts with similar meaning get numbers that point in a similar
direction (high *cosine similarity*).

**How do you stop an analyst reading someone else's incident through search?**
Qdrant gives only ids. MySQL filters by the user's permission before anything is shown, and IOC values or asset names of
hidden incidents are never revealed.

**How do you know the ranking is any good?**
We ran a pre-registered evaluation with 24 queries written by a teammate. Hybrid was best when evidence exists. It is
not statistically proven, and we say so.

**Did you tune the weights to get better numbers?**
No. They were fixed first and fingerprinted. Tuning on the test queries would make the test meaningless.

**What was the hardest bug?**
A deadlock between parallel workers (found by a test) and a truncation bug in the JavaScript embedding library (found by
comparing with an independent Python version). Both are fixed and tested.

**What would you do next?**
More evaluation queries from more writers, an install test on a separate computer, comparing the model files with the
official release, and deciding on visibility option B or C.

---

## 17. Glossary

- **Analyst / admin**: the two roles. Analysts work incidents; admins also assign, close, reopen and manage users.
- **Asset**: a computer, server or service that was affected.
- **Audit trail**: a permanent record of who changed what and when.
- **CSRF**: a trick where another website makes your browser send a request; blocked by checking the request origin.
- **Cosine similarity**: how close in direction two vectors are (1 = same, 0 = unrelated).
- **Embedding / vector**: the number list that represents the meaning of a text.
- **IDOR**: guessing another user's id in a URL to see their data; blocked here by answering 404.
- **Migration**: a numbered SQL file that changes the database structure in a controlled order.
- **Outbox**: a table of to-do jobs written in the same transaction as the data change.
- **Procedure / trigger / view**: stored code (procedure), automatic reaction to a change (trigger), a saved query that acts like
  a table (view).
- **Synthetic data**: made-up data created by code.
- **Transaction**: a group of changes that either all happen or none do.
