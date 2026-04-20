# Masjidly Minimal Runbook

This is the minimal setup to keep Masjidly running:

1. Scrape masjid websites
2. Ingest masjid mailing emails
3. Scrape mapped masjid Instagram accounts
4. Normalize/enrich into unified JSON
5. Sync unified JSON into SQLite DBs
6. Serve API + UI

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

Optional Instagram auth for deeper pagination:

```bash
export IG_SESSIONID="<instagram sessionid cookie>"
```

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

If Supabase env vars are set, it also syncs to Supabase Postgres table `public.events`.

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
