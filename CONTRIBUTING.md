# How we work together

This project has two people. These rules keep us from overwriting each other's work and keep the Git history honest, so it shows who really did what.

## One-time setup (each person)

```bash
git config --global user.name  "Your Real Name"
git config --global user.email "the-email-linked-to-your-github-account"
git clone <repo-url>
cd sentineldb
cp .env.example .env     # fill in your own passwords. NEVER commit .env
npm ci
```

Then follow "How to run it" in the [README](README.md).

Use the **email linked to your GitHub account**. If it does not match, GitHub will not count your commits as yours.

## Who owns what

Each area has one main owner. You can still change another area, but tell the owner first (a short message or an issue) and ask them to review the pull request.

| Area | Main owner | Files |
|---|---|---|
| Core database logic: lifecycle triggers, procedures, grants, audit trail | Dasari Vinay ([@v1nayd](https://github.com/v1nayd)) | `db/migrations/0001`-`0009`, `0012`-`0014`, `db/grants.sql.tpl`, `db/demo/live_demo.sql`, `scripts/migrate.ts`, `scripts/apply-grants.sh`, `scripts/bootstrap-db.sh` |
| Search: embeddings, Qdrant, sync worker, ranking, evaluation | Dasari Vinay ([@v1nayd](https://github.com/v1nayd)) | `db/migrations/0015`, `src/lib/embedding*`, `src/lib/qdrant*`, `src/lib/sync.ts`, `src/lib/correlate.ts`, `scripts/sync-worker.ts`, `scripts/eval*.ts`, `scripts/spike.ts`, `eval/`, `docs/RANKING.md`, `docs/MODEL.md` |
| Analytics, indexing and database documentation: analytic views and report queries, EXPLAIN and index review, DDL demo, data dictionary and ER, integrity checks, seed data | Dwijesh Krishna ([@Dwijesh60](https://github.com/Dwijesh60)) | `db/migrations/0010`-`0011`, `db/reports/`, `db/seed/`, `db/demo/ddl_demo.sql`, `scripts/seed*`, `scripts/generate-seed.ts`, `scripts/reports.ts`, `scripts/explain.ts`, `scripts/ddl-demo.ts`, `scripts/data-dictionary.ts`, `docs/DATA_DICTIONARY.md`, `docs/ER.md`, `docs/INDEXING.md` |
| Web app: pages and API routes | shared (agree before starting) | `src/app/`, `docs/API.md`, `docs/DEMO.md` |
| Tests | whoever changes the code writes its tests | `tests/` |
| README and docs | shared | `README.md`, `docs/` |

## Daily workflow

Nobody pushes straight to `main`. Everything goes through a branch and a pull request (PR).

```bash
git checkout main
git pull                              # always start from the latest main
git checkout -b yourname/short-topic  # e.g. dwijesh/add-report-index

# ...work, then save in small steps...
git add <files>                       # prefer naming files over `git add .`
git commit -m "Add index for analyst workload report"

git push -u origin yourname/short-topic
```

Then on GitHub: open a Pull Request into `main`, ask the other person to review it, and merge it when it is approved and the checks are green.

After it is merged:

```bash
git checkout main
git pull
git branch -d yourname/short-topic
```

If `git push` says the branch is behind, run `git pull --rebase` (or `git pull`) first, fix any conflicts, run `npm test`, then push again.

## Commit messages

One short line that says what changed, starting with a verb: `Add`, `Fix`, `Update`, `Remove`.

- Good: `Fix last-admin check in account procedure`
- Bad: `changes`, `final`, `asdf`

## Database migrations: special rules

Migrations are numbered (`0016_...sql`) and **checksummed**. This causes two rules:

1. **Never edit a migration that is already merged.** The runner will see a different checksum and fail. Add a new migration instead.
2. **Two people must not create the same number.** Before you add a migration, pull `main`, take the next free number, and say so in your PR title. If both of you add `0016`, the second person renames theirs to `0017` before merging.

After any migration change, run `npm run db:reset && npm run db:grants && npm test`.

## What must never be committed

- `.env` or any file with real passwords (only `.env.example` is allowed)
- `node_modules/`, `.next/`, `.data/` (local database files), model weights (downloaded by `npm run model:setup`)
- Anything in `phase1/` changed (it is our submitted work, and its hashes are checked)

If you commit a secret by mistake, tell the other person right away and change that password. Deleting it in a later commit does not remove it from history.

## Before you open a PR

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (needs MySQL and Qdrant running)
- [ ] You added or updated tests for what you changed
- [ ] You updated the docs if behaviour changed
- [ ] No secrets, no big generated files

## Using AI tools

AI assistants (such as Claude Code) are allowed as helpers. How we used them, and the checks applied to their output, are described in [docs/AI_USAGE.md](docs/AI_USAGE.md). The rules:

- You must understand and be able to explain every line you commit. We may be asked about it in the viva.
- Run the tests yourself. Do not trust "it works" from an AI tool.
- Do not add an AI tool as a commit author or co-author. The person who commits is responsible for the change.
- If AI helped a lot with a part, say so in the PR description, and keep the "How we used AI" section of the README accurate.
