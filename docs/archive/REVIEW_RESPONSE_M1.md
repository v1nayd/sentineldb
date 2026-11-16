# Response to the independent Milestone 1 review (12 Oct 2026)
> **Archived working note.** Written with the help of Claude Code (an AI coding assistant) during development. Where it says "I" or "you", that is the assistant's review text addressed to the team, not a team member. Kept as project history. How AI was used in this project: [docs/AI_USAGE.md](../AI_USAGE.md).


> **Superseded in part by [`REVIEW_RESPONSE_M1_FINAL.md`](REVIEW_RESPONSE_M1_FINAL.md).** Row 1 below calls the grants work "Done"; the final review showed that was overstated (the runtime account could still create/promote administrators). Test counts quoted here (47) are historical; the current suite has 71.

Every item is classified: **Done** (changed + tested, evidence cited) · **Decided** (design written in `DECISIONS.md`, built in the named milestone) · **Open** (needs the team) · **Cannot fix here** · **Clarification**.
Raw output of the full verification run: `docs/evidence/` (regenerate with `./scripts/verify-all.sh`). Test count at that point: **47** (was 24); current: 71.

## The seven required items

| # | Review item | Disposition | What changed / evidence |
|---|---|---|---|
| 1 | Redesign DB grants so audit immutability and lifecycle can be enforced | **Done** (baseline) · extended in M2 | Runtime account now has **no** schema-level grant; `scripts/apply-grants.sh` does `REVOKE ALL` then applies per-table/column grants from `db/grants.sql.tpl`. Separate `sentinel_app_test` account for tests (test schema only). `tests/grants.test.ts` (10 tests) **executes SQL as the runtime-equivalent account**: cannot insert/update `status`/`resolved_at`/`assigned_to`, cannot touch `Incident_Status_History`, cannot delete incidents/users/assets/IOCs/playbooks, notes append-only, no DDL/GRANT/`schema_migrations`, no cross-schema access (error codes 1142/1143/1044 asserted). Also found by doing this: with binary logging on, a non-SUPER migrator **cannot create triggers** (error 1419, reproduced) — fixed in config (`log_bin_trust_function_creators` / `--skip-log-bin`) before it could block M2. ADR-3. |
| 2 | Plan seeded history vs. lifecycle triggers | **Decided** (ADR-2) · partly **Done** | Live creation always `open` (already enforced by column-level INSERT grants + tested; trigger in M2). Historical data is **replayed through the real lifecycle** with a back-dating clock honoured only for the import account — rules are not weakened for app users. Seeds now load into an **empty** DB only, in one transaction (`scripts/seed.ts` refuses otherwise; verified: second run exits 1). The M1 seed is labelled legacy. |
| 3 | Embedding identity/version checks; plan full vector reconciliation | **Done** | `src/lib/embedding-spec.ts`: fingerprint over the **actual bytes** of all four model files + recipe (dims, pooling, normalisation, max tokens, truncation rule, preprocessing, impl version); files re-verified against `models/MANIFEST.json` on every load (tamper/missing tests); fingerprint names the Qdrant collection and is stamped in every payload; foreign vectors make search throw. Wrapper validates length/finiteness/unit norm. `reconcile()` classifies **every** id (ok/missing/orphaned/stale/incompatible); test reproduces your offsetting scenario (4 points = 4 incidents while 1 missing + 1 orphan + 1 stale + 1 incompatible are all reported) and a non-ASCII narrative proving MySQL `SHA2` = Node sha256. The spike now uses `reconcile()` instead of a point count. Archived/deleted handling: single `indexableWhere` predicate (exercised in a test); `archived_at` itself arrives in M2. ADR-5. |
| 4 | Don't adopt the redacted cross-incident view by default | **Done / Open** | Withdrawn as a default in `PHASE2_AUDIT.md`. Baseline = the original strict policy. Options A/B/C with costs (including that B is still an information oracle) are in ADR-1; **the team must choose**. |
| 5 | Fix model-verification instructions; keep provenance unresolved | **Done** (instructions) · **Cannot fix here** (provenance) | Fixture `scripts/verify/texts.json` + `npm run verify:embedding` (runs end-to-end; cosine 1.000000 on all 6 texts); also part of `verify-all`. Provenance stays **unresolved** — Hugging Face is unreachable from the build workspace; the exact comparison to run on your machine is in `docs/MODEL.md`. |
| 6 | Group work into the four agreed phases | **Done** | Mapping table added to the audit. M1–M6 remain internal milestones. |
| 7 | Reproducible commands and real output | **Done** | `scripts/verify-all.sh` + `docs/evidence/` (versions, typecheck, 47 verbose test results, spike, embedding cross-check, build, model hashes, audit JSON, `npm ci` timing). It was run from a fresh copy of the repo following the README (shared MySQL/Qdrant servers with the dev copy, so it is a clean *checkout*, not a clean *machine*). |

## Findings table

| Finding | Disposition |
|---|---|
| 13 spike checks aren't retrieval accuracy | **Accepted.** README and audit already call it a smoke test; not quoted as accuracy anywhere. |
| Vector-only ranking weak; same candidate set for all three methods | **Accepted** — M4 evaluation will use one candidate set, held-out labelled queries, same cut-offs. |
| Input length | Truncation flag + >256-token test + cross-check already exist; surfacing it in UI/evaluation is M4/M5. |
| Outbox ordering | **Decided** (ADR-5): version fencing, one in-flight job per incident, no overwrite of a higher payload version, reconcile as backstop. Honest limit: no cross-system atomicity. |
| Audit retention / `changed_by` SET NULL | **Accepted, decided** (ADR-4): users never deleted, FKs `RESTRICT`, actor id + name snapshot + DB account + source, archive columns, no physical incident delete. Shipped as migration 0002+ (0001 untouched). |
| PostgreSQL trigger syntax | **Accepted** (ADR-6); required no-op-update tests listed; the spec's `AFTER UPDATE OF` line is now in the audit's defect list. |
| Migration lock | **Done** — `GET_LOCK` scoped to the schema; test shows a second runner refuses while the first holds it, then succeeds after release. |
| Seed repeatability | **Done** — baseline-for-empty-DB policy, documented in the seed header and ADR-2. |
| Health endpoint liveness vs readiness | **Deferred to M4** (as you suggested, once lexical fallback exists). |
| Docker reproducibility | MySQL pinned to `8.0.46`, plus `--skip-log-bin`. The tag is **unverified** (Docker Hub blocked) — if Docker reports it missing, use the nearest 8.0.x. Compose is still never run. |
| Dependency security | **Done** — raw JSON committed; `DEPENDENCY_AUDIT.md` traces each advisory to where the package is used; two patched `overrides` took production audit from **3 high → 0 high** (5 moderate remain, one install-time-only chain); 47 tests + cross-check + spike re-run after the change. |
| Phase 1 diagram quality | Unchanged by design; corrected diagram is part of M6. |
| Git history | Not touched by me. Initialise on your machine and commit under your own identities now; suggested first split: member A — `db/`, `scripts/apply-grants.sh`, `tests/grants|migrate|baseline`; member B — `src/lib/embedding*`, `qdrant`, `reconcile`, `tests/embedding|vector|reconcile`. |

## Clarifications (not disagreements)

- The redacted cross-incident view was only ever a **proposal** in the M1 audit (I wrote that I'd default to it unless told otherwise); no code implements it. It is now withdrawn as a default.
- M1–M6 came from section 13 of the master prompt you gave me. I had not seen the four-phase agreement text; I adopted your mapping as written.
- Why your `npm install` may have timed out: a clean `npm ci` here took **40 s** but produces **1.3 GB** in `node_modules` (`onnxruntime-node` alone is 536 MB because it ships CPU/CUDA/TensorRT provider libraries). That is my guess about your environment, not something I could confirm; a longer timeout or more disk should fix it.

## Still unresolved

1. Upstream provenance of the model weights (needs huggingface.co access).
2. Docker Compose never executed here.
3. ADR-1 (analyst cross-incident visibility) — team decision.
4. Everything in M2–M6.
