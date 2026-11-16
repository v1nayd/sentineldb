# AI-assisted development statement

This document describes how AI tooling was used to build SentinelDB, what the team did and decided, and how AI-produced code was verified before it was accepted. It is written for reviewers (academic, industry or security) who want to judge the process as well as the result.

## Summary

SentinelDB was developed with **Claude Code** (an AI coding assistant by Anthropic) as an engineering tool. The assistant was used to draft and iterate on implementation of the technically complex parts of the system. The team set the requirements and design, made the architectural and policy decisions, ran every component against real services, reviewed the output, and decided what was accepted. The AI was not trusted as a source of truth: every claim of correctness in this repository is backed by an executable test, an independent check, or a recorded command output, not by the assistant's statement that something works.

This statement covers Phase 2. Phase 1 (the schema and ER design) is a separate, previously submitted deliverable that is preserved unchanged and hash-locked (`phase1/`, `docs/phase1.sha256`). Phase 2 builds on it, and a test proves that migration `0001` reproduces the submitted schema exactly (`tests/baseline-equivalence.test.ts`).

## Who did what

| Responsibility | Team | AI assistant |
|---|---|---|
| Problem definition, scope, requirements | Yes | No |
| Phase 1 schema and ER design | Yes | Not part of this statement |
| Architecture and design decisions (see `docs/DECISIONS.md`) | Decided by the team. Options, costs and trade-offs were drafted with the assistant's help, and the team chose (for example the analyst visibility policy, ADR-1) | Presented options and drafted ADR text |
| Implementation of complex components | Directed, reviewed, corrected, accepted | Drafted and iterated on code |
| Evaluation queries used to judge the ranking | Written by a team member, under a protocol that requires the writer not to have written the data generator and not to run any ranking method while writing. The writer's statement is recorded in `eval/README.md`. It is a statement by the team, not something the tooling can check | Wrote only the smoke queries that test that the harness runs. The runner labels them as not an evaluation |
| Running the system, tests and demos on real MySQL and Qdrant | Yes | Assisted with scripts |
| Accepting or rejecting changes, and responsibility for the repository | Yes | No |

## Where AI assisted, and how the result was checked

| Area | How the AI was used | How it was verified (not by the AI's say-so) |
|---|---|---|
| Database logic: triggers, state machine, stored procedures, audit tables (`db/migrations/`) | Drafting SQL and iterating on edge cases | Tests that execute real SQL against MySQL, including forced rollbacks and concurrent sessions (`tests/lifecycle`, `procedures`, `evidence`, `accounts`); catalog-level equality with the Phase 1 schema |
| Least-privilege permissions (`db/grants.sql.tpl`) | Drafting grants | An exact privilege-matrix test that runs SQL as the restricted runtime account (`tests/grants.test.ts`) |
| Embedding pipeline | Drafting the TypeScript implementation | An independent implementation in Python (onnxruntime and tokenizers) compared on the same texts: cosine 1.000000 (`scripts/verify/`, `docs/evidence/embedding-crosscheck.txt`); model file hashes pinned in `models/MANIFEST.json` |
| MySQL to Qdrant sync (transactional outbox, worker, reconciliation) | Drafting the worker and its failure handling | Tests for retries, version fences, lock takeover and repair (`tests/sync`, `sync-failure`, `reconcile`) and mutation checks of the critical lines (`docs/evidence/mutations-m4.txt`) |
| Hybrid ranking and its evaluation tooling | Drafting code and metric computation | Metric code is unit-tested (`tests/eval-metrics.test.ts`). The ranking is judged on queries the AI did not write, and the results are reported as measured, including where hybrid does not win (`eval/README.md`) |
| Authentication, sessions, roles, API routes | Drafting handlers and tests | Access and IDOR tests against the HTTP layer, mutation-checked (`tests/api-auth`, `api-access`, `api-workflow`); a production-mode end-to-end smoke run (`npm run e2e:smoke`) |
| Web UI | Drafting components | End-to-end checks plus a real-browser interaction check (`scripts/ui-browser-check.mjs`, `docs/evidence/ui-browser-check.txt`) |
| Documentation | Drafting and structuring | The team reads and corrects it. Generated documents (data dictionary, ER) come from the live database catalog |

## Controls applied to AI-assisted code

1. **Real-system testing, no mocking of database behaviour.** The 230 tests run against a real MySQL server and a real Qdrant server, as the least-privilege test account.
2. **Mutation checks.** Critical lines (visibility filter, version fences, claim locking, lock takeover) were deliberately broken to confirm that the tests fail. The results are recorded in `docs/evidence/`, including mutants that **survived**, so weak tests are visible rather than hidden.
3. **Independent cross-checks.** The embedding pipeline is checked against a second implementation written in a different language and library.
4. **Review cycle that found real defects.** An independent review of Milestone 1 found that the runtime database account could create admin users and change roles. It was fixed and covered by tests that check the privileges actually granted, not only the denials that were intended (`docs/archive/REVIEW_RESPONSE_M1_FINAL.md`).
5. **Honest reporting.** The status table in `docs/STATUS.md` separates what was only written from what was run and what an automated test asserts. Known limits are listed in the README.
6. **Supply-chain hygiene.** Dependencies are pinned to exact versions with a lockfile. A dependency audit is recorded (`docs/DEPENDENCY_AUDIT.md`, `docs/evidence/npm-audit-*.json`). The model files are verified by SHA-256 on every setup, and their provenance caveat is documented (`docs/MODEL.md`).
7. **Secure-by-design constraints that do not depend on trusting generated code.** Database permissions limit what the application account can do even if application code is wrong (per-table and per-column grants, audit tables that cannot be edited, state changes only through procedures and triggers). Queries are parameterised (`docs/ARCHITECTURE.md`, security boundaries).
8. **Data and secrets.** The project uses synthetic data only, so no real incident data exists to leak to any tool. Credentials live in `.env`, which is git-ignored. Only `.env.example` is committed.

## Rules for the team

These are also in [`CONTRIBUTING.md`](../CONTRIBUTING.md):

- Anyone who commits code must be able to explain it.
- Tests are run by the author of the change. A statement from an AI tool that something works is not evidence.
- AI tools are not listed as commit authors or co-authors. The person who commits is accountable.
- If an AI tool produced a large part of a change, the pull request says so.

## Limitations of this process

AI-generated code can contain subtle errors, including security errors, and can sound more certain than it is. The controls above reduce that risk but do not remove it. The main residual limits are listed in the README: the data is synthetic, the evaluation is small (24 queries), and the application trusts the web tier to state who is acting. A reviewer who finds a defect is encouraged to open an issue.
