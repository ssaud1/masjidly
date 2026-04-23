#!/usr/bin/env python3
"""
Instagram-only Safar pipeline (no website scrapers, no Gmail).

Steps:
  1) Per-masjid JSON stubs for mapped IG sources
  2) scrape_nj_masjid_instagram.py (skip with SAFAR_SKIP_INSTAGRAM=1)
  3) enrich_all_masjids.py
  4) ensure_synthetic_jummah.py
  5) sync_supabase_events.py (canonical Supabase events table update)
  6) SQLite mirrors + target_masjids_future_events_detailed.json
  7) safar-mobile/assets/seed-events.json + seed-meta.json (bundled cold-start data)
  8) events_by_masjid/_index.json

Does not run: website refresh scripts, ingest_masjid_emails, audit_posters,
build_event_dashboard, generate_source_health_dashboard, refresh_speaker_content.

Local — full IG list (same as daily pipeline):
  .venv/bin/python safar_instagram_pipeline.py

Local — smoke test (subset of accounts; comma-separated):
  SAFAR_FAST_MODE=1 SAFAR_INSTAGRAM_USERNAMES=iceb.nj,icpcnj .venv/bin/python safar_instagram_pipeline.py

Local — refresh enrich + mobile seed from existing events_by_masjid JSON only:
  SAFAR_SKIP_INSTAGRAM=1 .venv/bin/python safar_instagram_pipeline.py

CI: .github/workflows/instagram-pipeline.yml
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import safar_daily_pipeline as sdp


def main() -> None:
    sdp.PIPELINE_STEPS = []
    t0 = time.perf_counter()
    sdp.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    sdp.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    sdp.ensure_masjid_event_json_stubs()

    fast_mode = os.getenv("SAFAR_FAST_MODE", "0") == "1"
    run_env: dict[str, str] = {
        "ENRICH_INCREMENTAL": "1",
        "ENRICH_FILE_WORKERS": "2" if fast_mode else "3",
        "ENRICH_DEEP_OCR": "0" if fast_mode else "1",
    }

    if os.getenv("SAFAR_SKIP_INSTAGRAM", "0") == "1":
        print("[skip] scrape_nj_masjid_instagram.py (SAFAR_SKIP_INSTAGRAM=1)")
    else:
        insta_cmd = [sdp.PY, "scrape_nj_masjid_instagram.py"]
        ig_sleep = os.getenv("SAFAR_INSTAGRAM_SLEEP_SECONDS", "").strip()
        ig_skip_recent = os.getenv("SAFAR_INSTAGRAM_SKIP_RECENT_HOURS", "").strip()
        supports_max_pages = sdp.scraper_supports_flag("--max-pages")
        if fast_mode:
            sleep = ig_sleep or "1.4"
            insta_cmd.extend(["--days", "60", "--post-count", "30"])
            if supports_max_pages:
                insta_cmd.extend(["--max-pages", "36"])
            insta_cmd.extend(["--atomic-scrape", "--sleep-seconds", sleep])
        else:
            sleep = ig_sleep or "3.0"
            insta_cmd.extend(["--days", "365", "--post-count", "40"])
            if supports_max_pages:
                insta_cmd.extend(["--max-pages", "96"])
            insta_cmd.extend(["--atomic-scrape", "--sleep-seconds", sleep])
        if ig_skip_recent:
            insta_cmd.extend(["--skip-recent-hours", ig_skip_recent])
        sdp.run_instagram_scrape(insta_cmd, run_env)

    sdp.run([sdp.PY, "enrich_all_masjids.py"], extra_env=run_env)
    sdp.run([sdp.PY, "ensure_synthetic_jummah.py"], extra_env=run_env)
    sdp.run([sdp.PY, "sync_supabase_events.py"], extra_env=run_env)

    sdp.sync_db(sdp.DB_ALL, sdp.TARGET_ALL)
    sdp.sync_db(sdp.DB_FUTURE, sdp.TARGET_FUTURE)
    sdp.save_json(sdp.TARGET_DETAILED, sdp.load_json(sdp.TARGET_FUTURE))

    sdp.write_mobile_seed()
    sdp.update_index()

    total_s = round(time.perf_counter() - t0, 2)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_path = sdp.REPORT_DIR / f"instagram_pipeline_run_{stamp}.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "mode": "fast" if fast_mode else "full",
                "instagram_only": True,
                "total_duration_s": total_s,
                "steps": sdp.PIPELINE_STEPS,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[done] Instagram-only pipeline complete in {total_s}s report={report_path}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"[error] command failed: {exc}")
        sys.exit(1)
