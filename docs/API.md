# SentinelDB HTTP API (Milestones 3–4)

All endpoints are JSON under `/api`. Implemented in `src/app/api/**/route.ts`; every handler is wrapped by `api()` in `src/lib/http.ts` (enforced by `tests/route-structure.test.ts`).

## Rules that apply to every endpoint

| Rule | Behaviour |
|---|---|
| Authentication | Session cookie `sdb_session` (`__Host-sdb_session` + `Secure` in production). Missing / expired (8 h absolute) / idle (30 min) / revoked session → **401**. |
| Roles | `admin`-only endpoints answer **403** to analysts. The database re-checks the same rules (SDB11). |
| Visibility (ADR-1 option A) | Analysts see and act on incidents they **reported or are assigned to**; admins see all. Outside your scope an incident answers **404**, exactly like a missing one. |
| CSRF | Any non-GET request must carry `Origin: <APP_ORIGIN>` (or `Sec-Fetch-Site: same-origin`); otherwise **403**. For curl: add `-H "Origin: http://localhost:3000"`. |
| Bodies | `Content-Type: application/json` (else 415), ≤ 64 KB (else 413), **strict** schemas: an unknown field is a **400**, never silently ignored (no mass assignment). |
| Budget | 300 requests / minute per user (per process) → **429**. Login has its own limits, below. |
| Errors | `{"error": {"code", "message", "rule"?}}`. `rule` is the database rule (e.g. `SDB12`) when a trigger or procedure refused. |
| Caching | Every response is `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. |

Database rule → HTTP status: SDB10/12/13/14/15/40 → **409** (state conflict), SDB11 → **403**, SDB31/44 → **404**, SDB16/17/30/42 → **400**, SDB02 (deactivated actor) → **401**. SDB01 and SDB43 mean a server bug → 500.

## Endpoints

| Method & path | Who | Body / query | Notes |
|---|---|---|---|
| `POST /api/auth/login` | anyone | `{email, password}` | 200 + cookie. Every failure: 401 `invalid_credentials`. 5 failures / 15 min per e-mail → 429 (also with the right password); 100 failures / min globally → 429; per-IP 20 / 15 min only behind a proxy (`TRUST_PROXY_HEADERS=true`). |
| `POST /api/auth/logout` | user | — | Revokes the session server-side. |
| `GET /api/auth/me` | user | — | `{user: {id, name, email, role}}` |
| `POST /api/auth/password` | user | `{current_password, new_password}` | ≥ 12 characters. Ends **all** your sessions; the response carries a fresh cookie. |
| `GET /api/incidents` | user | `?status&severity&assigned=me\|unassigned&q&page&page_size` | Active (non-archived) incidents in your scope; `q` = keyword (LIKE, wildcards escaped). |
| `POST /api/incidents` | user | `{title, narrative, severity}` | 201. You are the reporter; it starts open and unassigned. |
| `GET /api/incidents/:id` | user (scope) | — | Incident, IOCs, assets, notes, status / assignment / evidence history, and `allowed_transitions` for you. |
| `PATCH /api/incidents/:id` | user (scope) | `{title?, narrative?, severity?}` | 409 if closed (SDB13) or archived (SDB14). |
| `POST /api/incidents/:id/transition` | assignee or admin | `{to, reason?}` | `to` ∈ open…resolved (not `closed`). 409 for a disallowed move or a missing reason; 403 if you are not the assignee. |
| `POST /api/incidents/:id/close` | admin | `{reason?}` | 409 SDB12 while an IOC is unreviewed or an asset impact undescribed (message gives the counts). |
| `POST /api/incidents/:id/reassign` | admin | `{assignee, reason}` | Atomic with the assignment audit row and a handover note. |
| `POST /api/incidents/:id/archive` | admin | `{reason}` | Closed incidents only; archived incidents are read-only. |
| `POST /api/incidents/:id/notes` | user (scope) | `{content}` | Append-only; author = you. |
| `POST /api/incidents/:id/iocs` | user (scope) | `{ioc_type, ioc_value, threat_level?, notes?}` | Value validated per type and normalised; registered if new; 409 if already linked. |
| `PATCH /api/incidents/:id/iocs/:iocId` | assignee or admin | `{review_status}` | pending / confirmed / dismissed. Reviewer and time are stamped by the database. |
| `DELETE /api/incidents/:id/iocs/:iocId` | user (scope) | — | Audited, including the review state that was lost. |
| `POST /api/incidents/:id/assets` | user (scope) | `{asset_id, impact_description?}` | |
| `PATCH /api/incidents/:id/assets/:assetId` | user (scope) | `{impact_description}` | |
| `DELETE /api/incidents/:id/assets/:assetId` | user (scope) | — | Audited. |
| `GET /api/assets` | user | — | Inventory. |
| `POST /api/assets`, `PATCH /api/assets/:id` | admin | asset fields | Asset type is immutable. |
| `GET /api/users`, `POST /api/users` | admin | `{name, email, password, role}` | Never returns password hashes (the runtime DB account cannot even read them). |
| `GET /api/users/:id`, `PATCH /api/users/:id` | admin | `{role?, active?}` | 409 SDB40 for the last active admin. Deactivation ends the user's sessions. |
| `POST /api/users/:id/password` | admin | `{password}` | Reset; ends that user's sessions. |
| `GET /api/analytics` | admin | — | Severity × status, workload, MTTR, monthly trend, recurring IOCs (the M2 views). |
| `GET /api/incidents/:id/similar` | user (scope) | `?k=1..50` (default 10) | Similar incidents: score, components, contributions, shared IOCs/assets, explanation, `index_state`; `mode` = `hybrid` or `lexical_fallback`. Only incidents in your scope ([RANKING.md](RANKING.md)). |
| `POST /api/search/similar` | user | `{text, iocs?: [{ioc_type, ioc_value}], asset_ids?, k?}` | "Have we seen this before?" for a description not yet filed; IOC values normalised per type. |
| `GET /api/sync` | admin | — | Outbox: jobs by action/status, incidents by index state, recent failures. |
| `POST /api/sync` | admin | `{action: "run" \| "repair"}` | Process due jobs now (≤ 500); `repair` first reconciles MySQL with Qdrant and re-queues / deletes what differs. |
| `GET /api/health` | anyone | — | `{ok, mysql, qdrant}`; 503 when a store is down. |

Not yet: playbook application endpoints. The UI (M5) uses exactly these endpoints.
