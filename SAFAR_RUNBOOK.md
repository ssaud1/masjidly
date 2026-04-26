# Masjid.ly Minimal Runbook

This is the minimal setup to keep Masjid.ly running:

1. Scrape masjid websites
2. Ingest masjid mailing emails
3. Scrape mapped masjid Instagram accounts
4. Normalize/enrich into unified JSON
5. Sync unified JSON into SQLite DBs
6. Serve API + UI

## Sustainability (Hosted, not laptop-bound)

Production data freshness and backend health should run via GitHub Actions + hosted backend/Supabase, not a local Mac session:

- Use `.github/workflows/daily-pipeline.yml` for full daily refresh + Supabase sync + commit-back.
- Use `.github/workflows/instagram-pipeline.yml` for Instagram-only refresh + Supabase sync + commit-back.
- Use `.github/workflows/backend-hosted-smoke.yml` to smoke-check hosted API endpoints (`/api/meta`, `/api/events`, `/api/speakers?speaker_normalize=ai`).
- Set these repo secrets in GitHub: `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `WEBSHARE_PROXIES` (optional fallback behavior exists).

Local runs are for debugging only; sustained operation should rely on the workflows above.

## Daily Pipeline

Run:

```bash
.venv/bin/python safar_daily_pipeline.py
```

Modes:

- Fast mode (3x/day): MCGP + MCMC + Al Falah + email + incremental enrichment + dashboard
  ```bash
  SAFAR_FAST_MODE=1 .venv/bin/python safar_daily_pipeline.py
  ```
- Full mode (nightly): all sources + deep OCR + poster audit + dashboard
  ```bash
  SAFAR_FAST_MODE=0 .venv/bin/python safar_daily_pipeline.py
  ```

This updates:

- `events_by_masjid/iceb_events.json`
- `events_by_masjid/mcmc_events.json`
- `events_by_masjid/mcgp_events.json`
- `events_by_masjid/darul_islah_events.json`
- `events_by_masjid/nbic_events.json`
- `events_by_masjid/alfalah_events.json`
- `events_by_masjid/icpc_events.json`
- `events_by_masjid/iscj_events.json`
- `events_by_masjid/icsj_events.json`
- `events_by_masjid/masjid_al_wali_events.json`
- `events_by_masjid/masjid_muhammad_newark_events.json`
- `target_masjids_events.json`
- `target_masjids_future_events.json`
- `target_masjids_events.db`
- `target_masjids_future_events.db`

Instagram compare reports are written to:

- `events_by_masjid/_reports/instagram_tandem_compare_<stamp>.md`
- `events_by_masjid/_reports/instagram_tandem_compare_<stamp>.json`

### Local Instagram scraping playbook (429s, cookies, pacing)

Do this **on your Mac** before scaling to CI. Goal: fewer **429** responses from `web_profile_info` and the profile HTML page.

#### 0) Same IP as the browser (critical with `sessionid`)

Instagram ties `sessionid` to **where you logged in**. If you copy cookies from Chrome on your **home Wi‑Fi**, run the scraper from that **same network without a proxy** (`--proxy-file` omitted). Sending that session through **Decodo** (another country) often yields **429** or HTML shells with **no user id** — exactly “not working” even with a valid token.

#### 1) Session cookies (biggest win)

Use a **normal** Chrome (or Firefox) window where you are logged into **instagram.com** with the account you use day-to-day (does not need to be a masjid account).

**Chrome**

1. Open `https://www.instagram.com/` while logged in.  
2. **DevTools** → **Application** (or **Storage**) → **Cookies** → `https://www.instagram.com`.  
3. Copy **`sessionid`** (long string) and **`csrftoken`**.  
4. Put them in repo **`.env`** (gitignored), not in committed files:

```bash
# ~/.env is wrong — use the repo root .env next to safar_daily_pipeline.py
IG_SESSIONID="paste_sessionid_here"
IG_CSRFTOKEN="paste_csrftoken_here"
```

If DevTools copied the session with **URL encoding** (`%3A` instead of `:`), the scraper now **decodes** that automatically (`normalize_instagram_session_cookie`).

The scraper reads these env vars automatically (`scrape_nj_masjid_instagram.py` sets cookies on the `requests` session). Same mechanism as using logged-in state in a browser.

**Direct IP + session (recommended when cookies came from home Chrome):**

```bash
set -a && source .env && set +a
export IG_ACCOUNT_SLEEP_SECONDS=60
.venv/bin/python scrape_nj_masjid_instagram.py \
  --days 90 --post-count 30 --atomic-scrape --sleep-seconds 6 \
  --usernames iceb.nj icpcnj
# no --proxy-file — uses your machine's public IP
```

**Safety:** `sessionid` is a live login — treat like a password; rotate by logging out of web IG if it leaks.

#### 2) Slow down (local tuning)

| Knob | What it does | Suggested local start |
|------|----------------|-------------------------|
| `--sleep-seconds` | Delay between **feed pagination** requests | `6`–`10` (try `8`) |
| `IG_ACCOUNT_SLEEP_SECONDS` | Pause **between masjid accounts** | `60`–`120` |
| `SAFAR_INSTAGRAM_USERNAMES` | Only some handles (comma-separated) | e.g. `iceb.nj,icpcnj` first |
| `SAFAR_IG_PAGE_SLEEP` | Used only by `scripts/run_instagram_scrape_local.sh` | default `6` |

**Example (Decodo CSV + cookies from `.env` + two accounts):**

```bash
cd /Users/shaheersaud/Safar
set -a && source .env && set +a
export SAFAR_DECODO_PROXY_FILE="/Users/shaheersaud/Downloads/data (1).csv"
export SAFAR_INSTAGRAM_USERNAMES="iceb.nj,icpcnj"
export IG_ACCOUNT_SLEEP_SECONDS=90
./scripts/run_instagram_scrape_local.sh
```

**Same thing without the helper script:**

```bash
set -a && source .env && set +a
export IG_ACCOUNT_SLEEP_SECONDS=90
.venv/bin/python scrape_nj_masjid_instagram.py \
  --days 365 --post-count 40 --atomic-scrape --sleep-seconds 8 \
  --proxy-file "/Users/shaheersaud/Downloads/data (1).csv" \
  --usernames iceb.nj icpcnj
```

#### 3) Spread runs in time

After a **long or failed** scrape, wait **hours** (or overnight) before hitting all **24** accounts again. Instagram throttles **bursts** across IPs that share the same product ASN or the same automation fingerprint.

#### 4) Expect `web_profile_info` to be fragile

Meta changes limits often. **Residential proxy + session cookies + slow pacing** is the practical combo; none of them alone is a guarantee.

---

Faster Instagram (parallel) without overloading one IP: use **one proxy URL per line** and split accounts across shards. The pipeline only enables parallel Instagram when a proxy file is set (otherwise it stays sequential).

```bash
# proxies.txt — one URL per line, e.g. residential/datacenter HTTP proxies
export SAFAR_INSTAGRAM_PROXY_FILE="/path/to/proxies.txt"
export SAFAR_INSTAGRAM_SHARDS=3
# optional: lower per-shard delay (each shard has its own IP)
export SAFAR_INSTAGRAM_SLEEP_SECONDS=1.2
.venv/bin/python safar_daily_pipeline.py
```

If `SAFAR_INSTAGRAM_SHARDS` is greater than `1` but `SAFAR_INSTAGRAM_PROXY_FILE` is missing, the pipeline forces **one shard** so you do not blast Instagram from a single IP.

### Proxifly CDN proxies (reduce bare-IP 401s)

The Instagram scraper is **Python**; we do not need the Proxifly **npm** package. The same public lists documented at [proxifly.dev](https://proxifly.dev) are fetched with **`proxifly_fetch.py`** (global **HTTP** list by default — one URL per line, ready for `requests`).

**One-shot file for the pipeline:**

```bash
.venv/bin/python proxifly_fetch.py -o instagram_proxies.txt --max 40
export SAFAR_INSTAGRAM_FORCE_PROXY=1
export SAFAR_INSTAGRAM_PROXY_FILE=instagram_proxies.txt
.venv/bin/python safar_instagram_pipeline.py
```

**Refresh that file automatically before every IG run** (pulls a fresh list from the CDN):

```bash
export SAFAR_PROXIFLY_REFRESH=1
export SAFAR_INSTAGRAM_FORCE_PROXY=1
export SAFAR_INSTAGRAM_PROXY_FILE=proxifly_proxies.txt
.venv/bin/python safar_daily_pipeline.py
```

Optional: `SAFAR_PROXIFLY_LIST_URL` — any list URL that returns lines starting with `http://`, `https://`, `socks4://`, or `socks5://`. The **US** country file on the CDN is mostly **SOCKS5**; `PySocks` is in `requirements.txt` so those work with `requests`.

GitHub Actions: if `WEBSHARE_PROXIES` is unset, the workflow runs `proxifly_fetch.py` into `instagram_proxies.txt` and still sets `SAFAR_INSTAGRAM_FORCE_PROXY=1`.

**HTTP 401 / 403 on the feed API:** the scraper no longer sits in a long retry loop on the same dead egress. It raises immediately; with **two or more** lines in the proxy file the pipeline passes `--proxy-file` and the scraper **rebuilds the session on the next proxy** before retrying the same masjid. With a single proxy it falls back to the HTML / first-page path (same as before). Optional pause between rotations: `IG_PROXY_ROTATE_SLEEP_S` (default `1.5`).

With a **multi-line** pool, the scraper also **rotates proxies until `web_profile_info` / HTML profile loads** (many bad free proxies die before the feed). If every line fails for that account, it skips that account and continues.

### Instagram-only pipeline

Use this when you only want Instagram → enrich → unified JSON → **mobile seed** (`safar-mobile/assets/seed-events.json` + `seed-meta.json`), without re-running every website scraper or Gmail.

```bash
./scripts/run_instagram_pipeline_local.sh
# or:
.venv/bin/python safar_instagram_pipeline.py
```

Smoke a **subset** of accounts (comma-separated usernames, same names as in `scrape_nj_masjid_instagram.py`):

```bash
SAFAR_FAST_MODE=1 SAFAR_INSTAGRAM_USERNAMES=iceb.nj,icpcnj .venv/bin/python safar_instagram_pipeline.py
```

**Enrich + seed only** (no Instagram network calls; uses existing `events_by_masjid/*` on disk):

```bash
SAFAR_SKIP_INSTAGRAM=1 .venv/bin/python safar_instagram_pipeline.py
```

GitHub Actions: workflow **Instagram scraper pipeline** (`.github/workflows/instagram-pipeline.yml`) — same proxy + cache pattern as the daily job, commits the same `target_masjids_*.json` and `safar-mobile/assets/seed-*.json` files.

**Where seed lives:** the bundled offline snapshot is only `safar-mobile/assets/seed-events.json` and `seed-meta.json` (same `write_mobile_seed()` as the daily pipeline). The API continues to read `target_masjids_future_events.json` from the repo / deploy artifact.

The Instagram-only script does **not** run `sync_supabase_events.py`. Use the full daily pipeline or run `sync_supabase_events.py` manually when Supabase must be updated.

**Daily pipeline only:** when Supabase env vars are set, `safar_daily_pipeline.py` also syncs to Postgres table `public.events`.

## Recommended Database (Vercel + Supabase)

Use **Supabase Postgres** as the primary app database, and use Vercel for hosting/API/frontend.

1. Run schema once in Supabase SQL editor:

```sql
-- file: supabase/schema_events.sql
```

2. Set env vars wherever pipeline runs:

```bash
SUPABASE_URL="https://<project>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

Compatible aliases are also supported:
- `supabaseurl` (URL)
- `servicerole` (service role key)
- `supabasekey` (fallback key; URL auto-derived from JWT ref if possible)

3. Pipeline sync script:

```bash
.venv/bin/python sync_supabase_events.py
```

## API Backend

Run:

```bash
.venv/bin/python safar_custom_app.py
```

Backend endpoints:

- `/api/meta`
- `/api/events`

Default URL:

- `http://127.0.0.1:5060`

## React Frontend

Run:

```bash
cd safar-react
npm install
npm run dev
```

Frontend URL:

- `http://localhost:5174`

The React app proxies `/api/*` to `http://127.0.0.1:5061` (configured in `safar-react/vite.config.js`).

## Daily Scheduling (macOS)

Install managed schedule:
- fast mode: `06:00`, `14:00`, `22:00`
- full mode: `02:00`

```bash
.venv/bin/python install_safar_schedule.py
```

Custom hours:

```bash
.venv/bin/python install_safar_schedule.py --fast-hours "5,13,21" --full-hour "2"
```

Remove schedule:

```bash
.venv/bin/python install_safar_schedule.py --remove
```

Cron logs go to:

- `events_by_masjid/_reports/pipeline_cron.log`
