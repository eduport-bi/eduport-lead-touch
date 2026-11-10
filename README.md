# Eduport · Lead Touch & Conversion Analytics

Replaces the Tableau workbook **"Lead Touch Combined"** with a drillable web app: every KPI goes down to the individual lead, its touch timeline, ICs, payments and calls.

```
sql/     Postgres: roles, Salesforce replica DDL, normalisation functions, views, materialized views, indexes, data-quality views, reconciliation
sync/    Salesforce -> Postgres incremental replication (Node, REST API, SystemModstamp watermarks) + MV refresh
api/     Cloudflare Worker (Hono + postgres.js over Hyperdrive) - /api/* + serves the built frontend, Cron Trigger for MV refresh
web/     React + Vite + TypeScript + Tailwind + Recharts + TanStack Query/Table
```

> **Read this first (state on 2026-09-19).** The Salesforce objects (`Lead_Master__c`, `Lead_Touch__c`,
> `Interested_Course__c`, `Task`) are **not in Postgres yet** - the production DB only has the app tables
> `home_customuser` / `home_payment`. Everything in `sql/` assumes a `salesforce.*` replica schema that
> `sync/` fills. Run the sync (step 3 below) before anything else will return rows. The field names,
> types and value distributions in this repo were verified directly against Salesforce (SOQL) and
> against Postgres (`home_*`), so the DDL matches what will land.

---

## 1. Architecture

```
Salesforce ──(sync/ every 15-30 min, REST queryAll, SystemModstamp)──▶ salesforce.* tables ─┐
                                                                                            ├─▶ analytics.v_* views ─▶ analytics.mv_* (refreshed by sync + Cron) ─▶ Worker /api ─▶ React
public.home_customuser / home_payment (app DB) ─────────────────────────────────────────────┘
```

* **Authority order**: `Lead_Master__c` is the grain for anything per lead. `Lead_Touch__c` is only joined for touch/attribution questions. Leads are never counted from touches.
* **All aggregation in Postgres.** The Worker only ships aggregates, plus paginated rows in the explorer / export (capped).
* **One filter parser** (`api/src/filters.ts`): zod-validated, dimension allowlist, every value a bound parameter.
* **Read-only role** (`lt_app_ro`) for the Worker; `default_transaction_read_only=on`, 20 s statement timeout.
* **Auth**: Cloudflare Access in front of the Worker; the Worker verifies the Access JWT (JWKS) on every `/api/*` call. Admin e-mails see raw phone/e-mail; viewers get masked values. No PII leaves the API except in the explorer / lead drawer / CSV export.

## 1b. How it is actually deployed (as of 2026-09-21)

* **Database**: Supabase project `duotauyrrxjmqpzdjtph` (Singapore). Schema created with `sql/ALL_supabase_simple.sql` (single `postgres` login, no extra roles). Role default `statement_timeout = 90s` protects against stuck web sessions; the sync sets it to 0 for its own session.
* **Worker + site**: https://leadtouch.eduportbi.workers.dev, deployed from a PC with `npx wrangler deploy` (wrangler logged in). Connects to Supabase through **Hyperdrive** (direct Worker->Supabase connections time out). **Login** (`AUTH_MODE=password`): accounts live in `app_auth.users` (`sql/016_app_auth.sql`), passwords are PBKDF2-SHA256, the session is an HttpOnly cookie (30 days, sliding). On the first visit after deploy the app shows a one-time **setup screen** that creates the first admin - the e-mail must be in `ADMIN_EMAILS`. Admins then use the **Access** page to add accounts, set passwords, promote other admins, disable or delete. Roles: *admin* (everything + Access page) and *user* (all dashboard pages). `AUTH_MODE=none` turns the login off (everyone gets `PUBLIC_ROLE`). Hyperdrive caches plain SELECTs for 60 s, so every auth query mentions `now()` to stay uncached.
* **Sync**: GitHub Actions `sync.yml` once a day at 06:00 IST (00:30 UTC, moved from 10:00 IST on 2026-11-10; six runs a day used ~900 of the 2,000 free Actions minutes a month, changed 2026-10-17; run it any time from Actions -> sync -> Run workflow). Salesforce login = client-credentials against the org My Domain (repo variable `SF_MY_DOMAIN=https://<your Salesforce My Domain>`). Secrets: `DATABASE_URL` (Supabase session pooler, port 5432, password URL-encoded), `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, optional `SF_USERNAME/SF_PASSWORD/SF_SECURITY_TOKEN`, and `SOURCE_DATABASE_URL` (production Postgres, read-only) for the payment tables.
* **Ops**: the sync workflow accepts a `sql` input (Actions -> sync -> Run workflow) that runs ad-hoc SQL against Supabase and prints the rows - use it for `SELECT * FROM analytics.refresh_all()`, `pg_stat_activity`, or the reconciliation queries.

## 2. Environment variables & secrets

| Where | Name | Purpose |
|---|---|---|
| DB (you run psql) | `ADMIN_DATABASE_URL` | superuser / owner for `sql/001` (roles + schemas) |
| DB | `OWNER_DATABASE_URL` | `lt_analytics_owner` for `sql/002-006`, `sync/` |
| DB | `RO_DATABASE_URL` | `lt_app_ro` for reconciliation / EXPLAIN |
| `sync/.env` | `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` | Salesforce connected app (client-credentials flow) |
| `sync/.env` | `DATABASE_URL` | = `OWNER_DATABASE_URL` |
| `sync/.env` | `TASK_SINCE`, `REFRESH_AFTER_SYNC`, `SYNC_OBJECTS` | optional |
| Cloudflare | Hyperdrive config | holds the `lt_app_ro` connection string (never in the repo) |
| `api/wrangler.toml [vars]` | `AUTH_MODE` (password / none), `PUBLIC_ROLE`, `ADMIN_EMAILS` (who may create the first admin), `APP_VERSION`, `EXPORT_ROW_CAP` | non-secret config |
| `api/.dev.vars` | `AUTH_MODE=none`, `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | local dev only |
| Worker secrets | `SMTP_USER` + `SMTP_PASS` (`cd api && npx wrangler secret put SMTP_USER`, then `SMTP_PASS`); vars `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM_NAME` | account e-mails: when an admin adds an account or sets a password, the Access dialog can e-mail the login link, e-mail and password to the person (api/src/email.ts, SMTP over a Workers TCP socket via worker-mailer). `SMTP_USER` = a Google mailbox such as bi_team@eduport.ai, `SMTP_PASS` = a Google App Password of that account (2-Step Verification must be on). Alternative: `RESEND_API_KEY` + `MAIL_FROM` (domain verified in Resend). Without secrets the checkbox is disabled and the admin shares the password by hand. |

Passwords for the two roles are set in `sql/001_schema_roles.sql` (`CHANGE_ME_*`) - change them before running, or `ALTER ROLE ... PASSWORD` afterwards.

## 3. Setup, step by step

### 3.1 Database (once)

```bash
# roles + schemas + Salesforce replica tables (as superuser)
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_schema_roles.sql

# functions, views, MVs (empty until the sync has run), data-quality views (as lt_analytics_owner)
psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/002_functions.sql -f sql/003_views.sql -f sql/004_matviews.sql -f sql/006_data_quality.sql

# indexes (CONCURRENTLY - autocommit, not inside a transaction)
psql "$OWNER_DATABASE_URL" -f sql/005_indexes.sql
```

`sql/004` ends with `SELECT * FROM analytics.refresh_all();` - on an empty replica that just creates empty MVs, which is fine.

Check the class mapping: `SELECT * FROM analytics.class_group_selftest() WHERE NOT ok;` must return 0 rows (it was verified against Postgres 16 on 2026-09-19 - all 28 cases pass).

### 3.2 Salesforce connected app

Setup → App Manager → New Connected App → enable OAuth, scopes `api` + `refresh_token`, **enable Client Credentials Flow** and pick a run-as integration user with read access to `Lead_Master__c`, `Lead_Touch__c`, `Interested_Course__c`, `Task`, `User`, `Course__c`. Copy consumer key/secret into `sync/.env`.

### 3.3 First replication + refresh

```bash
cd sync && cp .env.example .env   # fill it in
npm install
npm run sync:full                  # ~1.4M leads, 81k touches, ICs, Tasks since TASK_SINCE, Users, Courses; then refresh_all()
```

Expect the full load to take a while (REST pages of 2 000; roughly 700 pages for leads). Subsequent runs are incremental:

```bash
npm run sync            # cron this every 15-30 minutes (systemd timer / GitHub Actions / any box with Node 20+)
npm run refresh         # only refresh the MVs
```

Cron example (every 20 min):
```
*/20 * * * * cd /opt/eduport-lead-touch/sync && /usr/bin/npm run sync >> /var/log/lead-touch-sync.log 2>&1
```

### 3.4 Hyperdrive + Worker

```bash
cd api && npm install
npx wrangler login
npx wrangler hyperdrive create eduport-lead-touch-ro \
  --connection-string "postgres://lt_app_ro:PASSWORD@HOST:5432/DBNAME?sslmode=require"
# paste the returned id into wrangler.toml [[hyperdrive]] id
```

If Postgres is behind a firewall, allow Cloudflare's egress IPs or use a Cloudflare Tunnel (`hyperdrive create ... --access-client-id/--access-client-secret`).

### 3.5 Cloudflare Access (login)

Zero Trust → Access → Applications → **Self-hosted** → domain = the Worker's custom domain (e.g. `leads.eduport.ai`).
Policy: *Allow* → Emails ending in `@eduport.ai` (add One-time PIN and/or Google as login methods).
Copy the **Application Audience (AUD) tag** into `wrangler.toml` → `ACCESS_AUD`, and your team domain (`https://<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`. Put admin e-mails (unmasked PII) in `ADMIN_EMAILS`.

### 3.6 Deploy

```bash
cd web && npm install && npm run build     # -> web/dist
cd ../api && npx wrangler deploy           # uploads Worker + web/dist as static assets
npx wrangler deployments list
```

Then map the custom domain (Workers → Settings → Domains & Routes) and make sure the Access application covers it. The Cron Trigger (`15 */2 * * *`) is created automatically on deploy.

## 4. Local development against Postgres

```bash
# terminal 1 - API
cd api && cp .dev.vars.example .dev.vars   # AUTH_MODE=none for no login, local Postgres connection string
npm run dev                                 # http://127.0.0.1:8787/api/health

# terminal 2 - web (proxies /api to 8787)
cd web && npm run dev                       # http://localhost:5173
```

`AUTH_MODE=none` skips the login; never deploy with it. Useful checks:

```bash
curl -s "http://127.0.0.1:8787/api/kpis?from=2026-03-01&to=2026-08-31" | jq .data.current
curl -s "http://127.0.0.1:8787/api/breakdown?dim=touch_point&from=2026-03-01&to=2026-08-31" | jq '.data.rows[:5]'
```

## 5. API

All endpoints accept the shared filter params: `from`, `to` (YYYY-MM-DD, IST), `basis=created|touch|payment`, `compare=none|previous`,
`converted=1`, `dups=1`, `paid=paid|organic`, `paid_touch=…`, boolean flags `hot|supreme_hot|relogged|repeat|pre_existing=1|0`,
and comma-separated lists for every dimension key (`lead_source=Fb Ad,Website&touch_point=Meta Ad&owner=…`, `(null)` selects NULL).

| Endpoint | Returns |
|---|---|
| `GET /api/meta` | user/role, data-as-of, sync state, dimension catalogue, KPI definitions (+SQL) |
| `GET /api/filters?dim=&q=` | cascading options with counts (dim itself excluded from the filter) |
| `GET /api/kpis` | all KPI-row numbers for current (+previous) period incl. touch-bucket distribution |
| `GET /api/trend?grain=day\|week\|month` | leads / converted / touches / revenue per period (+previous), uses `mv_daily_lead_stats` when possible |
| `GET /api/breakdown?dim=&dim2=&limit=&sort=` | grouped metrics (lead grain or touch grain) + total, with previous-period values |
| `GET /api/attribution?dim=` | first / last / linear / position credit + revenue, diff vs last-touch, unattributed bucket |
| `GET /api/touch-curve?by=` | conversion by touch count, marginal lift, optimal touch count per group |
| `GET /api/touch-gaps`, `/api/touch-heatmap`, `/api/touch-transitions`, `/api/stale-leads?days=` | touch analysis |
| `GET /api/funnel` | stage distribution, IC funnel, discount leakage, IC-count curve, reasons, time-in-stage |
| `GET /api/cohorts?grain=` | cohort triangle (7/14/30/60/90), days-to-convert histogram, week-1 share |
| `GET /api/team` | per owner + per touch staff |
| `GET /api/movers` | biggest conversion-rate movers vs previous period |
| `GET /api/leads`, `/api/leads/:id`, `/api/leads/export.csv` | explorer (paginated, sorted, searchable, masked for viewers), drawer, streamed CSV (cap `EXPORT_ROW_CAP`) |
| `GET /api/data-quality`, `/api/data-quality/:check` | counts + rows for each check |
| `POST /api/admin/refresh` | admin-only manual `refresh_all()` |

Responses are `{ data, meta: { period, previous, basis, tookMs } }`; errors are `{ error: { code, message } }`.

## 6. Definitions (ported from the workbook) and deviations

* **Valid payment**: `payment_method = 0 AND deleted = false AND is_success AND payment_success AND home_customuser.is_deleted = false` → `analytics.v_valid_payment`.
* **Converted lead**: ≥ 1 valid payment matched on `analytics.phone_key()` (last 10 digits). `converted_at` = earliest valid `payment_date`.
* **Attributable touch**: `ist_date(Touch_Date__c) <= converted_at` (`mv_touch_base.is_pre_conversion`). Post-payment touches are shown in timelines but never credited.
* **Total leads** = `count(*)` from `mv_lead_base` in the window; **total touches** = `count(*)` from `mv_touch_base`.
* **Touches to convert** = `valid_touches` of converted leads (avg / median / p90 / buckets 0,1..5,6+).
* **First/last touch conversions** = converted leads with ≥ 1 attributable touch; the credit lands on that touch's touch point / source / medium / campaign.
* **Class group** = `analytics.class_group(Class__c)` - one function, fix it in `sql/002`.
* `Is_Deleted__c` / `IsDeleted` rows are excluded everywhere; duplicates excluded unless the toggle is on.

**Deliberate deviations / interpretations (flagged, see also `sql/900_reconciliation.sql`):**

1. `touch_date <= payment_date` is compared at **IST calendar-day** granularity (`payment_date` is a DATE). Same-day touches count as pre-conversion.
2. Class group adds **`Plus Two Completed`** (largest raw bucket, ~400k leads) and **`Unknown`** (NULL / "Not updated") instead of folding both into `Other`.
3. **Total touches** on the default basis = touches of leads *created* in the window. The touch-date basis (toggle) counts by `Touch_Date__c`. Reconciliation prints both.
4. Conversion **includes pre-existing customers** (payment before lead creation) exactly like the workbook; the UI flags them and offers a filter.
5. Paid/organic, response time, contact rate, cohorts, stale leads, movers, time-in-stage (approximation: stage history is not replicated) are **app additions** with no Tableau counterpart.
6. Time zone: all calendar dates are IST (`Asia/Kolkata`); Salesforce timestamps are UTC.

## 7. Reconciliation

The reconciliation sheet (dashboard vs Tableau vs Metabase, with the figures) is kept outside this repository.

## 8. Performance

* API reads only MVs. Expected default 30-day view: KPI query on ~40k rows via `mv_lead_base_created` index → well under 200 ms; attribution / curve scan ~10k touches. `sql/910_explain.sql` prints `EXPLAIN (ANALYZE, BUFFERS)` for the six heaviest statements - run it after the first refresh and paste the output into the sign-off.
* MV refresh (`analytics.refresh_all()`): the phone-key join between 1.4M leads and 754k users is the expensive part; both sides have expression indexes (`lead_master_phone_key`, `home_customuser_phone_key`). Refresh is `CONCURRENTLY` after the first run, so the API never blocks.
* **Response cache** (`api/src/cache.ts`, 2026-10-06). The data only changes when the sync refreshes the views, so every GET answered through `handle()` is cached on the *build id* (set per deploy by `api/scripts/deploy.mjs`, so a deploy invalidates everything) + the *data version* (latest `analytics.refresh_log.finished_at` / `_sync_state.last_run_at`) + role mask + path + sorted query. Two layers: isolate memory (≤150 entries / 24 MB) and the Workers KV namespace `CACHE` (binding in wrangler.toml; the Cache API is not functional on *.workers.dev). Misses write both layers in the background; errors are never cached; `/meta` is cached per user for 120 s. The response header `X-LT-Cache` says `hit-mem`, `hit-kv`, `miss` or `bypass`. Bypass the read with `?fresh=1` or a hard reload (the browser sends `Cache-Control: no-cache`). The version is re-read from the database at most once a minute per isolate (stale-while-revalidate), so new data shows within about a minute of the refresh. KV free tier allows 1,000 writes/day; a failed write only means a miss next time.
* **Warm-up.** The Worker cron (`*/10 * * * *`), the deploy script (right after `wrangler deploy`) and the sync job (right after the refresh) request the default 30-day view of every page (both bases, the five quick-picker lists) through `app.fetch` with a per-isolate internal token, so the first visitor after a sync gets cached answers. `POST /api/admin/warm` (admin session, or the `X-Warm-Secret` header = the `WARM_SECRET` Worker secret, kept in `api/.dev.vars` and the GitHub secret of the same name) does the same on demand and reports per-URL timings. Identical requests that arrive while one is still computing share its answer (single flight). The cron does **not** refresh the views any more (that is the sync job's task; a refresh through the pooled connection could be cut mid-transaction).
* **Overview fan-out** (2026-10-16): 22 statements run in parallel through `timedAll` (api/src/http.ts); any fan-out with a statement over 2 s logs every duration ("slow queries" in the Worker log) and a 500 carries `queryTimes`. The lead counts (New leads, Total leads on the created basis) read `analytics.mv_lead_lite` (sql/035) through covering indexes only: on the 1 GB instance the lead heap is evicted between requests and a cold heap scan cost 1-6 s, an index-only scan ~0.3 s. A cold 30-day filter change is ~2.5 s end to end; the same request cached is ~0.5 s.
* Cold numbers on the throttled free-tier database (2026-10-06): Overview 20 s, lead detail 29 s, Converted 8 s; any cached answer 0.3-0.5 s.

## 9. Adding a new chart

1. **SQL**: if the metric needs a new column, add it to the view in `sql/003_views.sql` (it flows into the MV automatically) and re-run 003 + 004.
2. **API**: add a route in `api/src/routes/` using `handle()` and `leadWhere()` / `touchWhere()` so it honours every global filter; add a `Definition` in `api/src/definitions.ts` if it becomes a KPI card.
3. **Types**: mirror the response in `web/src/lib/types.ts`.
4. **UI**: wrap the chart in `<ChartCard>` (gives you help "?", table toggle, PNG/CSV, empty/error/skeleton states) and use the primitives in `web/src/charts/index.tsx` (`HBars`, `VBars`, `Lines`, `Heatmap`, `QuadrantScatter`, `TrendChart`). For a plain "by dimension" bar chart, `<BreakdownCard dim="…" />` is enough - it already cross-filters.
5. Cross-filter by calling `toggleValue(dim, value)` from `useFilters()`; the dim must exist in `LEAD_DIMS` / `TOUCH_DIMS` (`api/src/filters.ts`) and `LIST_DIMS` (`web/src/lib/filters.ts`).

## 10. Security notes

* The browser never sees Postgres; credentials live only in Hyperdrive and `sync/.env`.
* Every `/api/*` request must carry a valid Cloudflare Access JWT for the configured audience; e-mail domain is re-checked in the Worker.
* PII masking is role-based server side; CSV export is masked for viewers too.
* Dimension names come from allowlists; `sql.unsafe` is used only for the fixed ORDER BY strings in `dq.ts` and the column list in the sync upsert - both from code constants.
* **CSV export password** (`api/src/routes/export_auth.ts`, sql/031, 2026-10-06). One shared password, set by admins on the Access page (hash in `app_auth.settings`, key `export_password`). Every CSV download asks for it: the streamed files (`/leads/export.csv`, `/converted/users.csv`, `/overview/leads.csv`, `/overview/new_leads.csv`) require it in the `X-Export-Password` header, files assembled in the browser (chart tables, Analysis results) verify it through `POST /api/export/verify` first. Until a password is set every export is refused (403). Each successful export and each failed attempt is written to `app_auth.audit` (actions `export_csv` / `export_password_failed`) and shows in the Access page activity list.
