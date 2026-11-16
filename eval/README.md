# Evaluation protocol (Milestone 4): keyword vs vector vs relational vs hybrid

This protocol is fixed **before** any evaluation query is run. Changing it after seeing results invalidates the
evaluation; if it must change, record why in `docs/DECISIONS.md` and re-run everything.

Version 2 (2026-11-04), revised after an external review and before any team query existed. The only run so far is the
author's smoke set, whose results were seen while writing this version; no ranking weight or formula changed because
of them.

## Question

Does adding relational evidence (shared IOCs and assets) to semantic similarity rank related past incidents better
than keyword search or vector search alone, on the SentinelDB demo dataset?

## Who writes the queries (the most important rule)

The dataset and its ground-truth labels (`db/seed/demo_labels.json`) were written by the same author as the ranking
code. Queries written by that author would test the author's own wording. Therefore:

- **Evaluation queries are written by a team member who did not write the narrative templates** (`scripts/seed/demo.ts`),
  without running any ranking method while writing them.
- Each query is run exactly once per method. No query is removed after seeing results.

`eval/smoke-queries.json` was written by the AI assistant that wrote the code. It only proves the harness works and is
**not** an evaluation; the runner prints a banner saying so.

## What the writer may see

**Only `eval/writer-pack.md`** (`npm run eval:pack`): family names, campaign and chain labels, their IOCs and assets.

Not the UI, the database, the seed files or the labels file. Narratives **and titles** come from the seed templates, so
seeing either leaks template wording into the queries and favours keyword and vector search. This is stricter than
allowing titles: "Mailbox quota phishing email" is template vocabulary too.

## Query file format

See `eval/queries.template.json`. Each query is a new incident as an analyst would describe it:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short unique name (it also seeds the query's tie-break) |
| `text` | yes | The narrative, in the writer's own words (2–5 sentences). An exact or near copy of a stored narrative (cosine ≥ 0.98) is refused |
| `family` | yes | One of the 12 families in the pack |
| `campaign` / `chain` | no | The label from the pack, if the query belongs to one |
| `iocs` | no | **At most 3**: `[{ "ioc_type": "domain", "ioc_value": "...", "source_incident": 33 }]`. `source_incident` is the active incident the value was copied from, as listed in the pack; the runner checks the link |
| `asset_names` | no | **At most 2**, by name |

Set: **at least 24 queries**, at least 1 per family. About half text only (no IOCs, no assets), about half with
evidence. Several of those with evidence should name a campaign or chain. Query incidents are never inserted into the
database: the runner only reads, and refuses to run if any incident lacks a label.

## Relevance (fixed)

- **Lenient:** a candidate is relevant if its family equals the query's `family`.
- **Strict:** only for queries with `campaign` or `chain`: relevant if it belongs to that campaign or chain.
- The source incident of a copied IOC **counts as relevant**, since it is. Because finding it is close to trivial, the
  runner also reports (a) how often it is the first hit, per method, and (b) strict metrics with source incidents removed
  from both the ranking and the relevant set. Read (b) as the honest measure of finding the *rest* of a campaign.

## Methods (same candidate set and cut-offs for all)

Candidates: **every active (non-archived) incident**. Every method scores every candidate. Equal scores are ordered by
a seeded permutation (`mulberry32 + Fisher-Yates`, seed = the first 32 bits of SHA-256 of `sentineldb-eval-v1:<query id>`),
**never by incident id**: ids are chronological and families are not spread evenly over time (mean id of ransomware 78,
of phishing 142), so an id tie-break would favour some families. The relational method on a text-only query is therefore
a chance baseline.

| Method | Score |
|---|---|
| keyword | MySQL FULLTEXT `MATCH(title, narrative) AGAINST (text IN NATURAL LANGUAGE MODE)`; no match = 0 |
| vector | cosine(embedding(text), embedding(narrative)), all-MiniLM-L6-v2 |
| relational | `(0.3 · iocs + 0.1 · assets) / 0.4`, components below (`relationalScore` in `src/lib/correlate.ts`) |
| hybrid | `0.6 · max(0, cosine) + 0.3 · min(shared IOCs, 2)/2 + 0.1 · min(shared assets, 1)` (`hybridScore`) |

"Shared" counts distinct IOCs or assets; an IOC link reviewed as `dismissed` on the candidate counts zero.

**"Text" in hybrid is the raw clamped vector cosine: no keyword score and no per-query normalisation.** So the weights
are nominal, not a 60/40 split of influence. Cosines between MiniLM narratives occupy a narrow band (about 0.27–0.76 in
our runs), so one shared IOC (+0.15) is worth a cosine difference of 0.25, a large part of that band. This is a known
property of the frozen formula, deliberately not tuned, and a reason to read the with-evidence block closely.

## Metrics and report format (fixed)

Per method: P@5, P@10, Recall@10, nR@10 (hits in the top 10 / min(10, R)), R-precision, MRR, averaged over queries.
R = number of relevant candidates. R differs a lot between families (11–33 active), which limits the plain metrics:
R@10 cannot reach 1 when R > 10, and P@5 cannot when R < 5. The report therefore states the best possible value of each,
and R per query. Compare families with nR@10 and R-precision.

Results are always reported in **three blocks: text-only, with IOC/asset, pooled.** On text-only queries hybrid orders
candidates exactly as vector does, so it ties by construction and any gain comes from the with-evidence block. The pooled
average therefore depends on the mix of queries: **conclusions about hybrid are drawn from the with-evidence block**, and
the runner checks the text-only identity.

Hybrid vs vector and hybrid vs keyword: per-query better / equal / worse with an exact two-sided sign test (ties
dropped), on MRR and P@10. With about 24 queries, one dataset and several comparisons, p-values are descriptive: differences
of a few points are noise, and no claim of statistical significance is made.

## Limits on what the result can mean

One synthetic dataset, written from templates by the code's author: results describe this dataset and do not generalise
to real incidents. Family-level relevance is coarse, and relevance comes from the generator's labels, not from analysts.

## Running

```bash
npm run db:reset && npm run db:grants && npm run db:seed -- demo   # the dataset the labels describe
npm run sync:worker -- --repair                                    # vector index in sync (the runner refuses otherwise)
npm run eval:pack                                                  # -> eval/writer-pack.md, for the writer
# ... the writer writes eval/queries.json and sets "frozen": true ...
npm run eval -- eval/queries.json --hash                           # prints the hashes: add them to the register below
npm run eval -- eval/queries.json                                  # -> docs/evidence/eval-queries.txt + .json
```

The runner refuses a frozen, team-written file unless the query-file, dataset, labels and code hashes are all in the
register, and refuses a second run of a registered file (`--rerun` reproduces it into a separate file). Do not change the
data between registering and running: even a demo edit changes the dataset fingerprint. Besides these hashes, each output
records the embedding model and spec, the ranking fingerprint, the MySQL version and the FULLTEXT settings
(`innodb_ft_min_token_size`, `innodb_ft_max_token_size`, stopword settings). If a git repository exists by then, add the
commit too; the code hash covers the ranking and evaluation files regardless.

Report results as they come out, **including if hybrid does not win**.

## Register (filled in BEFORE the first run)

| Query file | Written by | Frozen on | Query file SHA-256 | Dataset fingerprint | Labels SHA-256 | Code SHA-256 |
|---|---|---|---|---|---|---|
| `eval/queries.json` | Dwijesh Krishna | 2026-11-05 | `eadf5ec4f37b702c9a3182f86d9e36c548f8400b47641daedad996949077e66b` | `bb6adc7dd23db5aa11574713ccdbc75defbaf1535ddf9f6cb526310452da7689` | `091be9a4d1e7d34e8c5d016a6257bc4744de01607f47b247753a823c437b9f91` | `d0c4d26d9e929f4b94a4bac09e06275ec4bde26039fb7ed4705296ac0678c8a3` |

`eval/smoke-queries.json` is not registered: it is never an evaluation.

Writer's blindness statement (recorded 2026-11-05): Dwijesh Krishna had no reference material other than the generated
writer pack (`eval/writer-pack.md`) and the query-file format (`eval/queries.template.json`). He did not use the UI,
the database, the seed files or the labels. This was reported to the evaluation's operator by a team member; it is a
statement of the team, not something the tooling can check. Not recorded: what changed between his drafts, and whether
anyone else reviewed or edited the text before it was frozen. The file was frozen by changing only `"frozen"` to `true`
and renamed to `eval/queries.json`; its hash is in the register above.

## Result of the registered run (2026-11-05)

Run once, the registered hashes above matched, output in `docs/evidence/eval-queries.txt` and `.json` (ranking
`hybrid-v1`, fp `09d2a268dc80`, 24 queries, 228 active incidents, MySQL 8.0.46). Numbers are copied from that file.

**With IOC/asset queries (12), lenient (same family)**

| method | P@5 | P@10 | R@10 | R-prec | MRR |
|---|---|---|---|---|---|
| keyword | 0.667 | 0.550 | 0.302 | 0.474 | 0.710 |
| vector | 0.750 | 0.725 | 0.383 | 0.625 | 0.850 |
| relational | 0.867 | 0.575 | 0.326 | 0.387 | 1.000 |
| hybrid | 0.900 | 0.825 | 0.463 | 0.701 | 1.000 |

**Same 12 queries, strict (same campaign/chain), IOC source incidents removed from ranking and relevant set**

| method | P@5 | P@10 | R@10 | R-prec | MRR |
|---|---|---|---|---|---|
| keyword | 0.150 | 0.100 | 0.285 | 0.194 | 0.317 |
| vector | 0.233 | 0.142 | 0.472 | 0.229 | 0.344 |
| relational | 0.450 | 0.233 | 0.764 | 0.743 | 0.766 |
| hybrid | 0.450 | 0.267 | 0.847 | 0.674 | 0.836 |

**Text-only queries (12), lenient:** hybrid and vector are identical (top 10 differ on 0/12, as the protocol requires).
Keyword vs vector is mixed: keyword P@5 0.800 / MRR 0.870, vector P@5 0.733 / MRR 0.811 / P@10 0.700 vs 0.692.

**What this does and does not show**

- On queries that carry IOCs/assets, hybrid is best on every lenient metric above and does not lose to vector on any
  single query (P@10: 4 better / 8 equal / 0 worse, sign test p = 0.125; MRR: 2 / 10 / 0, p = 0.5). Against keyword,
  P@10 is 9 / 1 / 2 (p = 0.065). **No comparison reaches p < 0.05**: with 12 queries per block, treat these as
  consistent differences, not significant ones.
- Hybrid does **not** beat the relational-only method everywhere: on campaign (strict) queries relational is ahead on
  P@5 (0.667 vs 0.600) and R-precision (0.764 vs 0.649); hybrid is ahead on P@10 (0.375 vs 0.342) and R@10
  (0.860 vs 0.785). The relational score on text-only queries is a chance baseline by design.
- Hybrid's first hit was the incident an IOC was copied from in 5 of 12 queries (relational 4, keyword 1, vector 0), so
  the source-removed table is the fairer measure of finding the rest of a campaign.
- Several text-only queries are hard for every method (`stuffing-txt`, `c2-txt`, `ddos-txt`, P@10 <= 0.3 for vector
  and hybrid). Nothing was changed after seeing results.
- Limits from above apply: one synthetic dataset written from templates by the code's author, labels from the
  generator, not analysts. The pooled block averages in 12 queries where hybrid equals vector by construction, so quote
  the with-evidence block for hybrid-vs-vector comparisons.
