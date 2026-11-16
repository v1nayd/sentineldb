# Similar-incident ranking (Milestone 4)

Code: `src/lib/correlate.ts`. Endpoints: `GET /api/incidents/:id/similar`, `POST /api/search/similar` ([API.md](API.md)).
Evaluation protocol: [`eval/README.md`](../eval/README.md).

## Score

For a query q (an incident's narrative, or free text, plus the IOCs and assets it has) and a candidate incident d:

| Component | Definition | Range |
|---|---|---|
| text | max(0, cosine(embedding(q), embedding(d))), MiniLM-L6-v2 384-d | 0–1 |
| iocs | min(distinct shared IOCs, 2) / 2 | 0, 0.5, 1 |
| assets | min(distinct shared assets, 1) | 0, 1 |
| **hybrid** | **0.6 · text + 0.3 · iocs + 0.1 · assets** | 0–1 |

Every result carries its components, their weighted contributions (which add up to the score), the shared IOC values
and asset names, and a one-line explanation, e.g.
`71% semantic text similarity · shares 1 IOC (docs-account35.example) · same asset fileserver-01`.

## Why these choices

- **No double counting.** The narrative is scored once (semantic); keyword overlap is not added on top of it, because
  it measures the same text twice. An IOC linked to an incident counts once. A shared IOC whose link was reviewed as
  `dismissed` (a false positive) on either incident counts zero. An asset counts once.
- **Saturation.** Two shared indicators are already strong evidence; ten shared indicators should not drown the
  text. Assets saturate at one because shared infrastructure (a domain controller, the mail gateway) is common
  across unrelated incidents.
- **Weights are a priori, not tuned.** Text is always present, so it carries most weight; shared indicators are
  strong but sparse; shared assets are weak. The weights were fixed before any evaluation query existed, and
  `RANKING_FINGERPRINT` (a hash of the whole configuration) is printed with every evaluation run, so any later change
  is visible. Tuning them on the evaluation queries would make the evaluation meaningless.
- **The weights are nominal.** `text` is the raw clamped cosine, with no per-query normalisation. Cosines between MiniLM
  narratives sit in a narrow band (about 0.27–0.76 in our runs), so one shared IOC (+0.15) is worth a cosine difference of
  0.25: a shared indicator moves a result more than "30%" suggests. Known and deliberately not tuned.
- **Candidates.** The vector search returns the 100 nearest incidents, plus every incident sharing an IOC or asset.
  Relational-only candidates are then scored with their true cosine (Qdrant `has_id` filter), so nobody gets
  text = 0 just for missing the top 100.

## Authorisation

Qdrant returns ids only. Candidates are then filtered **in MySQL** by `incidentScope()`, the same function every
incident endpoint uses (ADR-1 option A): analysts only see incidents they reported or are assigned to; archived
incidents never appear, even when they share an IOC. Because the filter runs after retrieval, the search
over-fetches, and the response says when fewer than k authorised results remain. Shared IOC values and asset
names are shown only for incidents the user can see. An incident outside the scope answers 404 on `/similar`
(tested).

## Degraded mode

If the embedding model or Qdrant fails, the response has `mode: "lexical_fallback"` and a note. The text component
then comes from MySQL FULLTEXT (`MATCH(title, narrative) AGAINST (…)`, normalised by the best candidate), and each
result says `text_kind: "lexical"` and "keyword text similarity". It is never presented as semantic (tested by
deleting the collection).

## Index freshness

Each result has `index_state`, from `incident_sync_view` (synced / pending / failed / missing). When a candidate's
vector is not yet built from its current narrative, the explanation says its text score may be out of date. The
vector of the query itself is computed on the fly from the current narrative.

## Known limitations

- Free-text queries without IOCs or assets rank on text alone, so hybrid = vector for them.
- The weights are reasonable, not optimal. Whether hybrid beats vector-only is an **empirical question** for the
  held-out evaluation, to be reported even if the answer is no.
- Recency and severity are not part of the score (they are shown, not ranked on), to keep the components independent.
