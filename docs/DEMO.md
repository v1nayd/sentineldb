# Demo runbook (final, Milestone 6)

Three live segments, ≈ 15 minutes: the **UI** (end to end), **the database refusing rule violations** (SQL as the app's
own account), and **similarity search with the outbox**. All commands in **Git Bash** from the `sentineldb` folder.

## 0. Before the audience arrives (≈ 5 min)

```bash
# Services (skip a line if it is already running)
"/c/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe" --defaults-file="<path to my.ini>" --console &   # MySQL (MYSQL_PORT in .env)
bash scripts/qdrant-native.sh "<path to qdrant.exe>" &                                                   # Qdrant on 6333

# Clean demo dataset (240 incidents), its vectors, two logins
npm run db:reset && npm run db:grants && npm run db:seed -- demo
npm run sync:worker -- --once          # ≈ 25 s: embeds and indexes everything the seed queued; ends "IN SYNC"
npm run dev:logins -- priya.raman@sentinel.example aisha.khan@sentinel.example   # note both passwords
npm run build && npm start             # http://localhost:3000 (or `npm run dev`; open one page first, it compiles on demand)
npm run sync:worker                    # second terminal: keeps the index in sync while you edit things live
```

The runtime account's password (segment B) is `MYSQL_APP_PASSWORD` in `.env`.

## A. The application, end to end (≈ 6 min) — browser

| Step | Do | Point out |
|---|---|---|
| 1 | Open http://localhost:3000 → redirected to **Sign in**. Sign in as **Aisha** (analyst) | Server-side session; only a hash of the token is in MySQL |
| 2 | **Incidents**: 51 of 228 visible | Option A: only incidents she reported or is assigned to. Change the URL to `/incidents/1` → **404** (not hers; looks like "does not exist") |
| 3 | **Report**: type a ransomware description (e.g. "Files on the finance share were renamed and a note asks for payment") → **Check for similar incidents** | Hybrid ranking with a breakdown bar and an explanation per result, before filing |
| 4 | **Report incident** → its page | Timeline starts with "reported (open)" written by a **trigger**; badge "index pending" until the worker runs (watch the worker terminal) |
| 5 | Sign out; sign in as **Priya** (admin). Open the new incident → **Assign** to Aisha with a reason | `reassign_incident` procedure: assignee + history + handover note in one transaction |
| 6 | As Aisha (or Priya): link an IOC (`domain docs-account35.example`), link asset `fileserver-01`, move **→ investigating → resolved** | State machine in the database; `resolved_at` set by the trigger |
| 7 | As Priya: **Close** | Refused: *cannot close: 1 IOC(s) unreviewed, 1 asset(s) without impact description (rule SDB12)* — the database's own message |
| 8 | Set the IOC review to **confirmed**, describe the impact, **Close** again | Now accepted; the timeline shows every step with who did it |
| 9 | Scroll to **Have we seen this before?** | The ransomware campaign incidents rank high: *shares 1 IOC (docs-account35.example)* — relational evidence the vector alone would not see |
| 10 | **Analytics** | The M2 views live: severity × status, workload incl. unassigned, MTTR from the audit trail, monthly trend, recurring IOCs |
| 11 | **Index sync** | Outbox counts by state; reconciliation checks every id in Qdrant; "Reconcile + repair" |

## B. "The database says no" — SQL, as the app's own account (≈ 4 min)

```bash
mysql -h127.0.0.1 -P"$MYSQL_PORT" -u sentinel_app -p --force --table sentineldb < db/demo/live_demo.sql
```

15 steps; every `ERROR` line is a rule refusing something: the app account cannot read password hashes, set a status
or delete audit rows (1143/1142); anonymous write (SDB01); open → resolved (SDB10); close with unreviewed evidence
(SDB12); reassignment inside a transaction rolled back leaves no trace; the analytic views.

## C. Similarity search, the outbox and degraded mode (≈ 3 min)

| Do | Point out |
|---|---|
| **Similar search** page, ask the examiner for a sentence | Semantic matches without shared words; scores broken down |
| Add an IOC line, e.g. `domain docs-account35.example` | Campaign incidents rise: the IOC component of the score |
| Stop Qdrant (Ctrl+C in its terminal), search again | Yellow **Keyword fallback** banner: FULLTEXT, labelled, never passed off as semantic |
| Edit an incident's narrative while Qdrant is down, restart Qdrant | The job waits and retries with backoff; the worker catches up; Index sync returns to "In sync" |

## Optional extras (if asked)

| Question | Command / file |
|---|---|
| "Show CREATE / ALTER / DROP" | `npm run db:ddl-demo` |
| "Why these indexes?" | `npm run db:explain` or `docs/INDEXING.md` |
| "Show HAVING / subqueries / window functions" | `npm run db:reports -- analytics` |
| "Is the audit trail consistent?" | `npm run db:reports -- integrity` (ends with PASS) |
| "Does hybrid actually beat vector search?" | `eval/README.md`: the protocol is fixed and the registered run is done: 24 queries by a teammate, results in `eval/README.md` and `docs/evidence/eval-queries.txt` (hybrid best with IOCs/assets, not statistically significant; relational-only ahead on some campaign metrics). Do not re-run it live. The smoke run (`eval/smoke-queries.json`) only tests the harness. |
| "Do the tests pass?" | `npm test` (230 tests) or `docs/evidence/SUMMARY.txt`; `bash scripts/verify-all.sh` re-runs everything |
| "What does the schema look like?" | `docs/ER.md` (generated from the live catalog), `docs/DATA_DICTIONARY.md` |
| API only, from a terminal | `bash scripts/demo-api.sh '<aisha password>' '<priya password>'` (needs `npm run dev`) |

## If something fails on stage

- `ERROR 2003 Can't connect` / the app shows a 500 → MySQL is not running (step 0).
- Similar panel shows "Keyword fallback" unexpectedly → Qdrant is down; restart it, then **Index sync → Reconcile + repair**.
- "index pending" never clears → the worker is not running (`npm run sync:worker`).
- Sign-in fails with the right password → `dev:logins` ran before the last `db:reset`; run it again.
- `SDB…` errors where none are expected → the data is not the fresh demo seed; rerun the reset line.
