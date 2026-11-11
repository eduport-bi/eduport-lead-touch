> **Status 2026-09-21:** steps 1, 4, 5, 6 are DONE (Supabase created + schema, repo pushed, Hyperdrive created via CLI, Worker deployed at https://eduport-lead-touch.vishnudasp-eduport.workers.dev with no login). Salesforce sync logs in and loads. **Only `SOURCE_DATABASE_URL` (production Postgres, read-only `eduport_ro`) is still missing** - without it there are no payments, so conversions and revenue read zero. See README §1b for the final layout; the rest of this file is the original plan kept for reference.

# Setup checklist (do in this order)

Time needed: about 1.5 hours of clicking, plus 30–90 minutes waiting for the first data load.
You need: your Supabase login, your GitHub login, your Cloudflare login, a Salesforce admin, and the
read-only production Postgres credentials (the same ones Metabase uses, user `eduport_ro`).

Keep a scratch note open. You will collect these 9 values as you go:

| # | Value | Where you get it |
|---|---|---|
| 1 | `OWNER_PASSWORD` | you invent it (step 1.4) |
| 2 | `RO_PASSWORD` | you invent it (step 1.4) |
| 3 | `PROJECT_REF` + pooler host | Supabase (step 1.6) |
| 4 | `SOURCE_DATABASE_URL` | your DevOps / Metabase admin (step 2) |
| 5 | `SF_CLIENT_ID`, `SF_CLIENT_SECRET` | Salesforce (step 3) |
| 6 | `CLOUDFLARE_API_TOKEN` | Cloudflare (step 5.1) |
| 7 | Hyperdrive ID | Cloudflare (step 5.2) |
| 8 | Access team domain + AUD tag | Cloudflare Zero Trust (step 7) |
| 9 | Worker URL | Cloudflare after first deploy (step 6) |

---

## 1. Supabase – create the database (15 min)

1.1 Open https://supabase.com/dashboard (your organisation) and click **New project**.
1.2 Name: `eduport-lead-touch`. Region: **South Asia (Mumbai)**. Click **Generate a password**, copy it somewhere (this is the `postgres` superuser password, you need it only for psql later). Click **Create new project** and wait until the project is "Healthy".
1.3 Plan: on the left, **Project Settings → Billing**. Free tier is 500 MB. With the default `LEAD_SINCE=2025-04-01` (leads from April 2025 onward) the data fits. If you want all leads back to 2022, upgrade to **Pro** first.
1.4 Invent two strong passwords now: `OWNER_PASSWORD` (for the sync job) and `RO_PASSWORD` (for the website). Write them in your note.
1.5 Run the SQL. Left menu **SQL Editor → New query**. For each file below: open the file from the `sql/` folder in a text editor, select all, paste into the editor, click **Run** (bottom right). Wait for "Success" before the next one.
   1. `sql/001_schema_roles.sql` – **before running**, replace `CHANGE_ME_owner` (line 22) with `OWNER_PASSWORD` and `CHANGE_ME_ro` (line 25) with `RO_PASSWORD`.
   2. `sql/002_functions.sql`
   3. `sql/003_views.sql`
   4. `sql/004_matviews.sql` (ends by refreshing empty views – that is fine)
   5. `sql/006_data_quality.sql`
   6. `sql/005_indexes.sql`
   Check: run `SELECT * FROM analytics.class_group_selftest() WHERE NOT ok;` – it must return **0 rows**.
1.6 Get the connection string. Click the **Connect** button at the top of the dashboard, choose **Session pooler** (NOT Transaction pooler, NOT Direct). You will see something like:
   `postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
   The part after `postgres.` is your `PROJECT_REF`. Build two strings and save them in your note:
   * **DATABASE_URL** (sync, owner): `postgresql://lt_analytics_owner.PROJECT_REF:OWNER_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`
   * **HYPERDRIVE string** (website, read-only): `postgresql://lt_app_ro.PROJECT_REF:RO_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`
   (Replace PROJECT_REF and the passwords. If your region is not Mumbai, keep the host Supabase shows you.)

## 2. Production Postgres – read-only access for the sync (ask DevOps, 5 min)

The sync copies two tables (`home_customuser`, `home_payment`) from the production database into Supabase.
Ask whoever manages the production DB (or the Metabase admin) for the connection details of the read-only user `eduport_ro`: host, port, database name, password. Build:
`SOURCE_DATABASE_URL = postgresql://eduport_ro:PASSWORD@HOST:PORT/DBNAME?sslmode=require`
Also ask: **is the DB reachable from the internet?** GitHub Actions runs on public IPs. If the DB is firewalled, the sync must run on a company server instead (see "Alternative" at the end).

## 3. Salesforce – connected app (10 min, needs a Salesforce admin)

3.1 Salesforce **Setup → App Manager → New Connected App**.
3.2 Name `Lead Touch Sync`, contact email yours. Tick **Enable OAuth Settings**. Callback URL: `https://login.salesforce.com/services/oauth2/success`. Selected OAuth Scopes: add **Manage user data via APIs (api)**. Tick **Enable Client Credentials Flow**. Save. Click **Continue**.
3.3 On the app page click **Manage Consumer Details** (verify with the emailed code). Copy **Consumer Key** = `SF_CLIENT_ID` and **Consumer Secret** = `SF_CLIENT_SECRET` into your note.
3.4 Back on the app page: **Manage → Edit Policies**. Under **Client Credentials Flow → Run As**, pick an integration user (or an admin) who can read `Lead_Master__c`, `Lead_Touch__c`, `Interested_Course__c`, `Task`, `User`, `Course__c`. Save. Wait 10 minutes before first use (Salesforce propagation).

## 4. GitHub – push the code and store the secrets (10 min)

4.1 Go to https://github.com/new. Owner: `eduport-bi` (the GitHub organisation; the repository was moved there from the personal account on 2026-11-11). Name: `eduport-lead-touch`. **Private**. Do NOT add a README. Click **Create repository**.
4.2 On your PC, open a terminal in this project folder and run:
```bash
git init -b main
git add -A
git commit -m "Lead Touch analytics: SQL, sync, Worker API, React app"
git remote add origin https://github.com/eduport-bi/eduport-lead-touch.git
git push -u origin main
```
(If git asks you to log in, use your GitHub username and a Personal Access Token as the password.)
4.3 In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add these 7, one by one, names exactly as written:

| Name | Value |
|---|---|
| `SF_LOGIN_URL` | `https://login.salesforce.com` |
| `SF_CLIENT_ID` | from step 3.3 |
| `SF_CLIENT_SECRET` | from step 3.3 |
| `DATABASE_URL` | the owner string from step 1.6 |
| `SOURCE_DATABASE_URL` | from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | `ee558dc2a8ca2f421731d9b046ae5731` |
| `CLOUDFLARE_API_TOKEN` | from step 5.1 (come back and add it after step 5) |

4.4 Start the first data load: repo → **Actions** tab → left list **sync** → **Run workflow** → tick **Full reload** → **Run workflow**. Click into the run to watch the log. It prints one line per object (`[Lead_Master__c] 20000 rows...`). Expect 30–90 minutes. The last lines are `[refresh] analytics.mv_lead_base: N rows`.
   If it fails, open the failed step: the error tells you which credential is wrong.
4.5 From now on it re-runs automatically every 30 minutes.

## 5. Cloudflare – API token and Hyperdrive (10 min)

5.1 **API token**: https://dash.cloudflare.com/profile/api-tokens → **Create Token** → template **Edit Cloudflare Workers** → **Use template**. Under Permissions click **+ Add more**: `Account` / `Hyperdrive` / `Read`. Account Resources: your account. **Continue to summary → Create Token**. Copy it = `CLOUDFLARE_API_TOKEN`; add it as the 7th GitHub secret (step 4.3).
5.2 **Hyperdrive**: https://dash.cloudflare.com/ee558dc2a8ca2f421731d9b046ae5731 → **Storage & Databases → Hyperdrive → Create configuration**. Name `eduport-lead-touch-ro`. Choose **Connection string** and paste the HYPERDRIVE string from step 1.6 (the `lt_app_ro` one). Create. Copy the **Configuration ID** (a 32-character hex string).
5.3 Put it in the code: open `api/wrangler.toml`, replace `REPLACE_WITH_HYPERDRIVE_ID` with that ID. While you are there set `ADMIN_EMAILS = "bi_team@eduport.ai,YOUR_EMAIL@eduport.ai"` (admins see unmasked phone numbers).

## 6. First deploy (5 min)

6.1 Commit and push the `wrangler.toml` change:
```bash
git add api/wrangler.toml && git commit -m "Hyperdrive id" && git push
```
6.2 GitHub → **Actions → deploy** shows a run. When it is green, open Cloudflare → **Workers & Pages → eduport-lead-touch**. The page shows the URL, e.g. `https://eduport-lead-touch.YOURSUBDOMAIN.workers.dev`. Save it in your note.
6.3 Open `https://<that url>/api/health` in a browser – you must see `{"ok":true,...}`. The app itself will show "Missing Cloudflare Access token" until step 7 is done – that is expected and correct (nothing is public).

## 7. Cloudflare Access – the login (10 min)

7.1 Go to https://one.dash.cloudflare.com → pick the account. If asked, choose a **team name** (e.g. `eduport`) on the free plan. Your team domain is then `https://eduport.cloudflareaccess.com` – note it.
7.2 **Access → Applications → Add an application → Self-hosted**.
   * Application name: `Lead Touch`
   * Session duration: `24 hours`
   * Application domain: paste the Worker URL host from 6.2 (without `https://`), e.g. `eduport-lead-touch.YOURSUBDOMAIN.workers.dev`
   * Identity providers: leave **One-time PIN** ticked (add Google later if you want).
   Click **Next**.
7.3 Policy: name `Eduport staff`, action **Allow**. Include rule: selector **Emails ending in**, value `@eduport.ai`. **Next → Add application**.
7.4 Click the application you just made → **Overview** tab → copy **Application Audience (AUD) Tag** (64 hex characters).
7.5 Open `api/wrangler.toml` and set:
   * `ACCESS_TEAM_DOMAIN = "https://eduport.cloudflareaccess.com"` (your team name from 7.1)
   * `ACCESS_AUD = "<the AUD tag>"`
   Commit and push:
```bash
git add api/wrangler.toml && git commit -m "Access config" && git push
```
7.6 When the deploy is green, open the Worker URL. Cloudflare asks for your e-mail, sends a PIN, and then the dashboard loads. The header shows "Data as of …" and the Overview KPIs are non-zero once step 4.4 has finished.

## 8. Sign-off check (5 min)

8.1 Install psql if you do not have it (Windows: https://www.postgresql.org/download/windows/, only the "Command Line Tools" component is needed).
8.2 In the project folder run (replace with your owner string from 1.6):
```bash
psql "postgresql://lt_analytics_owner.PROJECT_REF:OWNER_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require" -f sql/900_reconciliation.sql
```
8.3 Compare block A (total leads), B1 (touches by touch date), C (converted, conversion %), D (avg touches to convert) and E (first/last-touch conversions) with the Tableau workbook for 1 Mar – 31 Aug 2026. Reference values already known from Salesforce: 250,233 leads, 52,214 touches, 17,153 leads flagged converted in Salesforce.
8.4 Paste the output back to me if anything differs; the deviations I made on purpose are listed in README §6.

---

### Alternative if the production DB is not reachable from GitHub
Run the sync on any company server that can reach both the internet and the production DB:
```bash
git clone https://github.com/eduport-bi/eduport-lead-touch.git && cd eduport-lead-touch/sync
cp .env.example .env      # fill in the same values as the GitHub secrets
npm install && npm run sync:full
crontab -e                # add:  */30 * * * * cd /path/eduport-lead-touch/sync && npm run sync >> sync.log 2>&1
```
Then disable the `sync` workflow in GitHub (Actions → sync → … → Disable workflow).

### If something goes wrong
* Sync log says `Salesforce login failed` → step 3.2/3.4 (client credentials flow or Run-As user).
* Sync log says `password authentication failed` → the `DATABASE_URL` user must be `lt_analytics_owner.PROJECT_REF` with `OWNER_PASSWORD`.
* Website shows "Invalid Access token" → `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` in `wrangler.toml` does not match step 7.4/7.1.
* Website loads but every card says "Could not load" → Hyperdrive string (step 5.2) is wrong, or the sync has not finished yet.
