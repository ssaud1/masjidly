# Safar / Masjidly

Event aggregator for NJ/NY-area masjids. Scraper pipeline + Flask API + Expo mobile app.

## Components

| Folder / file | What it is |
|---|---|
| `safar_custom_app.py` | Flask API (events, users, RSVPs, iqama, reflections). Entry point for production. |
| `safar_daily_pipeline.py` | Orchestrates every `refresh_*.py` scraper and rewrites `target_masjids_events.json`. Run on a schedule. |
| `refresh_*.py`, `ingest_masjid_emails.py`, `scrape_nj_masjid_instagram.py` | Individual scrapers. |
| `target_masjids_events.json` | Canonical events dataset. Flask API loads this at boot. |
| `masjidly_app.db` | Local user/session state (SQLite). Not committed. |
| `safar-mobile/` | Expo / React Native app. |
| `safar-react/` | Admin web UI (React + Supabase). |
| `safar-admin/` | Static admin page. |
| `supabase/` | Supabase schema for the admin mirror. |

## Local development

```bash
# Backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python safar_custom_app.py   # http://127.0.0.1:5060

# Refresh events (writes target_masjids_events.json)
python safar_daily_pipeline.py

# Mobile app
cd safar-mobile
npm install
# Point at your Mac's LAN IP so the phone can reach Flask
echo "EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:5060" > .env
npx expo start
```

## Production (Railway)

- `Procfile` runs `gunicorn safar_custom_app:app` bound to `$PORT`.
- `railway.toml` pins Nixpacks + sets a `/api/meta` healthcheck.
- `runtime.txt` pins Python 3.13.
- Persistent SQLite: mount a Railway volume and set `DB_PATH=/data/masjidly_app.db`.
- The daily pipeline should run as a Railway cron service (separate service, same repo, custom start command: `python safar_daily_pipeline.py`).

## Env vars

| Name | Used by | Notes |
|---|---|---|
| `PORT` | Flask | Set automatically by Railway. Defaults to `APP_PORT=5060` locally. |
| `APP_HOST` | Flask | Defaults to `0.0.0.0`. |
| `DB_PATH` | Flask | Absolute path for SQLite user DB. Point at a mounted volume on Railway. |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | `ingest_masjid_emails.py` | Required for email scraper. |
| `EXPO_PUBLIC_API_BASE_URL` | Mobile app | Public URL of the deployed Flask API. |
