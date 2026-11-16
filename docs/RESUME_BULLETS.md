# Resume / report bullets — measured facts only

Rule: every number below was produced by a command in this repository, and the source is named. Do not round up, do
not add numbers that were not measured, and do not reuse the Phase 1 spec's bullets. Synthetic data: say so.
Re-check the numbers against `docs/evidence/` before using them; they change when the code changes.

## Database (MySQL 8)

- Designed and built a MySQL 8 schema of **18 tables, 8 views, 40 triggers and 19 stored procedures/functions** across
  **15 versioned, checksummed migrations**, extending a Phase 1 design whose baseline is proven identical to the submitted
  DDL by a catalog-comparison test. *(docs/DATA_DICTIONARY.md, generated; tests/baseline-equivalence.test.ts)*
- Enforced an incident lifecycle **inside the database**: a table-driven state machine, role and assignee checks, a
  closure gate (all indicators reviewed, all asset impacts described) and immutable, trigger-written audit trails;
  verified with tests that run SQL as the least-privilege application account. *(tests/lifecycle, evidence, procedures)*
- Restricted the application's database account to **per-table and per-column grants** (it cannot read password hashes,
  set a status, or delete audit rows), checked by an exact privilege-matrix test. *(tests/grants.test.ts)*
- Chose indexes with `EXPLAIN ANALYZE` on a **50,000-incident** scaled copy: an analyst-queue query went from **1,112 to
  225 rows read** and a one-month range scan from **51,215 to 2,420 rows**; one planned index was **rejected** because
  it showed no gain. *(docs/INDEXING.md, docs/evidence/explain.txt; synthetic data, one laptop)*

## MySQL + vector search

- Kept a vector index (Qdrant) consistent with MySQL using a **transactional outbox written by triggers**, a worker with
  `FOR UPDATE SKIP LOCKED` claims, version fences and retry with backoff; a parallel-workers test found and fixed an
  InnoDB **deadlock**. Indexing the 240-incident dataset takes **≈ 21–25 s on a laptop CPU**. *(tests/sync.test.ts, docs/DECISIONS.md M4 notes)*
- Built an **explainable hybrid ranking** (semantic similarity + shared indicators + shared assets) that filters
  results by the user's access rights **after** retrieval, and falls back to a clearly labelled keyword search when the
  vector store is down. *(docs/RANKING.md, tests/correlate.test.ts)*
- Verified the embedding pipeline against an **independent Python implementation (cosine 1.000000)**, which exposed and
  fixed a truncation bug in the JavaScript library. *(scripts/verify/embedding-crosscheck.sh)*
- Evaluated keyword, vector, relational and hybrid ranking on **24 frozen queries written blind by a teammate** against a
  synthetic 228-incident dataset (protocol and hashes registered before the run). On the 12 queries that carry IOCs or
  assets, hybrid reached **P@10 0.825 vs 0.725 for vector and 0.550 for keyword** (MRR 1.00 vs 0.85 and 0.71); finding the
  rest of a campaign with the source incidents removed, **R@10 0.847 vs 0.472 (vector) and 0.285 (keyword)**. Differences
  are **not statistically significant** (best sign-test p = 0.065, 12 queries), and relational-only ranking was ahead of
  hybrid on campaign P@5 (0.667 vs 0.600); on text-only queries hybrid equals vector by construction.
  *(eval/README.md, docs/evidence/eval-queries.txt; synthetic data written from templates by the code's author)*

## Application and quality

- Implemented authentication (scrypt, server-side revocable sessions), two roles, object-level access control (other
  users' incidents answer 404) and a web UI with **zero added npm dependencies** beyond Next.js/React. *(package.json)*
- **230 automated tests on real MySQL and Qdrant** plus **21 end-to-end checks** against the production build and a
  real-browser interaction check; protections were **deliberately broken (mutation testing)** to confirm the tests catch
  each one. *(docs/evidence/tests.txt, e2e-smoke.txt, mutations-m4.txt, ui-browser-check.txt)*
- Kept production dependencies at **0 known vulnerabilities** (`npm audit`), patching two critical advisories in
  Next.js during the project. *(docs/DEPENDENCY_AUDIT.md)*

## Not claimable (yet)

- Any "improves search by X%" figure or the word "significant": the evaluation exists (24 queries, one synthetic dataset)
  but no comparison reaches p < 0.05, and the blind-writing statement by the query writer is still to be recorded in
  `eval/README.md`.
- Performance at production scale, real incident data, or a security audit by a third party.
- Installation on a separate physical computer (verified from fresh checkout copies on the development machine, natively and with Docker Compose; see `docs/evidence/fresh-checkout.txt` and `docs/evidence/docker-run.txt`).
