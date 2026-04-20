#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml dateparser playwright
#
# Run manually:
#   .venv/bin/python safar_daily_pipeline.py
#
# What it does (single ordered run):
# 1) Website scrapes: ICEB+MCMC (refresh_iceb_mcmc), MCGP, Al Falah, ICUC, ISMC, MCNJ,
#    plus Darul Islah + NBIC when not SAFAR_FAST_MODE.
# 2) Email: ingest_masjid_emails.py (Gmail IMAP; loads Safar/.env unless vars already set).
#    Skip with SAFAR_SKIP_EMAIL=1.
# 3) Instagram: scrape_nj_masjid_instagram.py (NJ masjids, posters + OCR path). Skip with
#    SAFAR_SKIP_INSTAGRAM=1.
# 4) enrich_all_masjids.py, optional audit_posters, dashboards, Supabase sync, SQLite.

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Tuple

from scrape_nj_masjid_instagram import DEFAULT_USERNAMES as IG_DEFAULT_USERNAMES, SOURCE_MAP as IG_SOURCE_MAP, normalize_proxy_line

ROOT = Path(__file__).resolve().parent
EVENTS_DIR = ROOT / "events_by_masjid"
# Prefer the venv interpreter when available; fall back to the current interpreter
# (Railway / CI containers don't have a local .venv, they invoke us with system python).
_VENV_PY = ROOT / ".venv" / "bin" / "python"
PY = str(_VENV_PY) if _VENV_PY.exists() else sys.executable

TARGET_ALL = ROOT / "target_masjids_events.json"
TARGET_FUTURE = ROOT / "target_masjids_future_events.json"
TARGET_DETAILED = ROOT / "target_masjids_future_events_detailed.json"
DB_ALL = ROOT / "target_masjids_events.db"
DB_FUTURE = ROOT / "target_masjids_future_events.db"
INDEX_FILE = EVENTS_DIR / "_index.json"
REPORT_DIR = EVENTS_DIR / "_reports"
SEED_DIR = ROOT / "safar-mobile" / "assets"
PIPELINE_STEPS: List[Dict] = []


def _ts() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%H:%M:%SZ")


def _short(cmd: List[str]) -> str:
    """Display name for a subprocess: basename of last .py arg, else full."""
    for part in reversed(cmd):
        if part.endswith(".py"):
            return Path(part).name
    return cmd[-1] if cmd else "?"


def run(cmd: List[str], extra_env: Dict[str, str] | None = None) -> None:
    name = _short(cmd)
    print(f"[pipeline {_ts()}] START  {name}  ({' '.join(cmd)})", flush=True)
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    t0 = time.perf_counter()
    subprocess.run(cmd, cwd=str(ROOT), check=True, env=env)
    dur = round(time.perf_counter() - t0, 2)
    print(f"[pipeline {_ts()}] DONE   {name}  ({dur}s)", flush=True)
    PIPELINE_STEPS.append(
        {"argv": cmd, "ok": True, "duration_s": dur}
    )


def run_parallel(cmds: List[List[str]], max_workers: int = 4, extra_env: Dict[str, str] | None = None) -> None:
    if not cmds:
        return
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    t0 = time.perf_counter()
    start_times: Dict[int, float] = {}
    still_running: Dict[int, List[str]] = {}

    def _runner(cmd: List[str]) -> None:
        name = _short(cmd)
        print(f"[pipeline.parallel {_ts()}] START  {name}", flush=True)
        t_start = time.perf_counter()
        start_times[id(cmd)] = t_start
        still_running[id(cmd)] = cmd
        try:
            subprocess.run(cmd, cwd=str(ROOT), check=True, env=env)
        finally:
            dur = round(time.perf_counter() - t_start, 2)
            print(f"[pipeline.parallel {_ts()}] DONE   {name}  ({dur}s)", flush=True)
            still_running.pop(id(cmd), None)

    stop_heartbeat = threading.Event()

    def _heartbeat() -> None:
        while not stop_heartbeat.wait(120):
            elapsed = round(time.perf_counter() - t0, 1)
            pending = [_short(c) for c in still_running.values()]
            if pending:
                print(
                    f"[pipeline.parallel {_ts()}] heartbeat elapsed={elapsed}s "
                    f"still_running={pending}",
                    flush=True,
                )

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_runner, cmd): cmd for cmd in cmds}
            for fut in as_completed(futures):
                fut.result()
    finally:
        stop_heartbeat.set()
    PIPELINE_STEPS.append(
        {
            "argv": ["[parallel_refresh]", f"n={len(cmds)}"],
            "ok": True,
            "duration_s": round(time.perf_counter() - t0, 2),
        }
    )


def _log_cmd_redact_proxy(cmd: List[str]) -> str:
    """Join argv for logs without printing proxy user:password."""
    parts: List[str] = []
    i = 0
    while i < len(cmd):
        if cmd[i] == "--proxy" and i + 1 < len(cmd):
            u = cmd[i + 1]
            tail = u.split("@", 1)[-1] if "@" in u else "…"
            parts.append(f"--proxy=<redacted>@{tail}")
            i += 2
            continue
        parts.append(cmd[i])
        i += 1
    return " ".join(parts)


def load_instagram_proxy_lines() -> List[str]:
    """
    One proxy URL per line (http://..., https://..., socks5://...).
    Used when SAFAR_INSTAGRAM_SHARDS>1 so each shard can use a different egress IP.
    """
    raw = os.getenv("SAFAR_INSTAGRAM_PROXY_FILE", "").strip()
    if not raw:
        return []
    p = Path(raw)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        print(f"[warn] SAFAR_INSTAGRAM_PROXY_FILE not found: {p}")
        return []
    out: List[str] = []
    for ln in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        norm = normalize_proxy_line(s)
        if norm:
            out.append(norm)
    return out


def run_instagram_scrape(base_cmd: List[str], run_env: Dict[str, str]) -> None:
    """
    Run Instagram scrape. Parallel shards only when a proxy file is provided so each
    shard can bind to a different IP (parallel requests from one IP increase ban risk).
    """
    t_ig = time.perf_counter()
    proxy_lines = load_instagram_proxy_lines()
    try:
        shards = max(1, int(os.getenv("SAFAR_INSTAGRAM_SHARDS", "1").strip() or "1"))
    except ValueError:
        shards = 1
    names = list(IG_DEFAULT_USERNAMES)
    n = len(names)
    if shards > 1 and not proxy_lines:
        print("[warn] SAFAR_INSTAGRAM_SHARDS>1 without SAFAR_INSTAGRAM_PROXY_FILE can overload one IP; forcing shards=1.")
        shards = 1
    if shards > n:
        shards = n
    if shards <= 1:
        cmd = base_cmd + ["--usernames"] + names
        print("[run]", " ".join(cmd))
        env = os.environ.copy()
        env.update(run_env)
        subprocess.run(cmd, cwd=str(ROOT), check=True, env=env)
        PIPELINE_STEPS.append(
            {"argv": cmd, "ok": True, "duration_s": round(time.perf_counter() - t_ig, 2)}
        )
        return
    groups: List[List[str]] = []
    for s in range(shards):
        sub = [names[i] for i in range(n) if i % shards == s]
        if sub:
            groups.append(sub)
    if len(proxy_lines) < len(groups):
        print(
            f"[warn] proxy file has {len(proxy_lines)} line(s) but {len(groups)} shard(s); "
            "the same proxy URL(s) will be reused across shards (add more lines for distinct IPs)."
        )
    env_base = os.environ.copy()
    env_base.update(run_env)

    def _run_shard(pair: Tuple[int, List[str]]) -> None:
        shard_idx, sub = pair
        cmd = base_cmd + ["--usernames"] + sub
        px = proxy_lines[shard_idx % len(proxy_lines)]
        cmd.extend(["--proxy", px])
        print("[run.instagram.parallel]", _log_cmd_redact_proxy(cmd))
        subprocess.run(cmd, cwd=str(ROOT), check=True, env=env_base)

    workers = min(len(groups), 8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(_run_shard, list(enumerate(groups))))
    PIPELINE_STEPS.append(
        {
            "argv": base_cmd + [f"(instagram_parallel_shards={len(groups)})"],
            "ok": True,
            "duration_s": round(time.perf_counter() - t_ig, 2),
        }
    )


def load_json(path: Path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:10]}")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def sync_db(db_path: Path, source_json: Path) -> None:
    data = load_json(source_json)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,
            source_type TEXT,
            source_url TEXT,
            title TEXT,
            description TEXT,
            date TEXT,
            start_time TEXT,
            end_time TEXT,
            location_name TEXT,
            address TEXT,
            city TEXT,
            state TEXT,
            zip TEXT,
            category TEXT,
            audience TEXT,
            organizer TEXT,
            rsvp_link TEXT,
            image_urls TEXT,
            raw_text TEXT,
            confidence REAL,
            speaker TEXT,
            quality_score REAL DEFAULT 0.0,
            quality_reason TEXT DEFAULT '',
            moderation_status TEXT DEFAULT 'approved',
            created_at TEXT,
            updated_at TEXT
        )
        """
    )
    cur.execute("DELETE FROM events")
    rows = []
    for e in data:
        rows.append(
            (
                e.get("source", ""),
                e.get("source_type", ""),
                e.get("source_url", ""),
                e.get("title", ""),
                e.get("description", ""),
                e.get("date", ""),
                e.get("start_time", ""),
                e.get("end_time", ""),
                e.get("location_name", ""),
                e.get("address", ""),
                e.get("city", ""),
                e.get("state", ""),
                e.get("zip", ""),
                e.get("category", ""),
                e.get("audience", ""),
                e.get("organizer", ""),
                e.get("rsvp_link", ""),
                json.dumps(e.get("image_urls", []), ensure_ascii=False),
                e.get("raw_text", ""),
                float(e.get("confidence", 0.0) or 0.0),
                e.get("speaker", ""),
                float(e.get("quality_score", 0.0) or 0.0),
                e.get("quality_reason", ""),
                e.get("moderation_status", "approved"),
                e.get("created_at", ""),
                e.get("updated_at", ""),
            )
        )
    cur.executemany(
        """
        INSERT INTO events (
            source, source_type, source_url, title, description, date, start_time, end_time,
            location_name, address, city, state, zip, category, audience, organizer,
            rsvp_link, image_urls, raw_text, confidence, speaker,
            quality_score, quality_reason, moderation_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    cur.execute("UPDATE events SET created_at = COALESCE(NULLIF(created_at,''), datetime('now'))")
    cur.execute("UPDATE events SET updated_at = COALESCE(NULLIF(updated_at,''), datetime('now'))")
    con.commit()
    con.close()
    print(f"[db] {db_path.name} rows={len(data)}")


def ensure_masjid_event_json_stubs() -> None:
    """Create empty per-source JSON files for newly added masjids so enrich/index always see them."""
    seen: set[str] = set()
    for meta in IG_SOURCE_MAP.values():
        src = (meta.get("source") or "").strip()
        if not src or src in seen:
            continue
        seen.add(src)
        p = EVENTS_DIR / f"{src}_events.json"
        if not p.exists():
            save_json(p, [])


def write_mobile_seed() -> None:
    """Dump a compact seed of future events + meta into the mobile bundle so the
    app shows real data on first launch / airplane mode, before any network call.

    Shape mirrors what /api/events and /api/meta return so `App.tsx` can swap in
    the bundled seed as a cold-start fallback without extra parsing.
    """
    if not SEED_DIR.exists():
        print(f"[seed] skip — {SEED_DIR} not present (safar-mobile not checked out)")
        return
    try:
        future = load_json(TARGET_FUTURE) if TARGET_FUTURE.exists() else []
        if not future:
            # Fall back to the full file if future-only slice is missing.
            future = load_json(TARGET_ALL)
    except Exception as exc:
        print(f"[seed] could not read events json: {exc}")
        return

    sources: List[str] = sorted({(e.get("source") or "").strip() for e in future if e.get("source")})
    dates = [e.get("date") for e in future if e.get("date")]
    min_date = min(dates) if dates else ""
    max_date = max(dates) if dates else ""

    try:
        mtime = int(TARGET_FUTURE.stat().st_mtime) if TARGET_FUTURE.exists() else int(time.time())
    except OSError:
        mtime = int(time.time())

    meta = {
        "data_version": f"{mtime}-v3",
        "default_reference": sources[0] if sources else "alfalah",
        "min_date": min_date,
        "max_date": max_date,
        "sources": sources,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "event_count": len(future),
    }

    seed_events_path = SEED_DIR / "seed-events.json"
    seed_meta_path = SEED_DIR / "seed-meta.json"
    save_json(seed_events_path, future)
    save_json(seed_meta_path, meta)
    print(
        f"[seed] wrote {seed_events_path.name} ({len(future)} events) + "
        f"{seed_meta_path.name} ({len(sources)} sources)"
    )


def update_index() -> None:
    counts: Dict[str, int] = {}
    for p in sorted(EVENTS_DIR.glob("*_events.json")):
        if not p.is_file() or p.name.startswith("_"):
            continue
        counts[p.name] = len(load_json(p))
    save_json(INDEX_FILE, {"counts": counts})
    print("[index]", counts)


def main() -> None:
    global PIPELINE_STEPS
    PIPELINE_STEPS = []
    pipeline_started = time.perf_counter()
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ensure_masjid_event_json_stubs()
    fast_mode = os.getenv("SAFAR_FAST_MODE", "0") == "1"
    run_env: Dict[str, str] = {
        "ENRICH_INCREMENTAL": "1",
        "ENRICH_FILE_WORKERS": "2" if fast_mode else "3",
        "ENRICH_DEEP_OCR": "0" if fast_mode else "1",
    }

    refresh_cmds = [
        [PY, "refresh_iceb_mcmc.py"],
        [PY, "refresh_mcgp_events.py"],
        [PY, "refresh_alfalah_events.py"],
        [PY, "refresh_icuc_events.py"],
        [PY, "refresh_ismc_events.py"],
        [PY, "refresh_mcnj_events.py"],
        # Lightweight scrapers for the previously-empty masjids (jmic/icoc/bayonne_mc/isbc/mcjc).
        [PY, "refresh_more_masjid_websites.py"],
    ]
    if not fast_mode:
        refresh_cmds.extend(
            [
                [PY, "refresh_darul_islah_events.py"],
                [PY, "refresh_nbic_events.py"],
            ]
        )
    run_parallel(refresh_cmds, max_workers=6, extra_env=run_env)
    if os.getenv("SAFAR_SKIP_EMAIL", "0") == "1":
        print("[skip] ingest_masjid_emails.py (SAFAR_SKIP_EMAIL=1)")
    else:
        run([PY, "ingest_masjid_emails.py"], extra_env=run_env)
    if os.getenv("SAFAR_SKIP_INSTAGRAM", "0") == "1":
        print("[skip] scrape_nj_masjid_instagram.py (SAFAR_SKIP_INSTAGRAM=1)")
    else:
        insta_cmd = [PY, "scrape_nj_masjid_instagram.py"]
        # Slower requests reduce Instagram rate limits; tune with SAFAR_INSTAGRAM_SLEEP_SECONDS.
        ig_sleep = os.getenv("SAFAR_INSTAGRAM_SLEEP_SECONDS", "").strip()
        if fast_mode:
            sleep = ig_sleep or "2.2"
            insta_cmd.extend(["--days", "60", "--post-count", "30", "--atomic-scrape", "--sleep-seconds", sleep])
        else:
            sleep = ig_sleep or "3.5"
            # Download → local OCR → single merge per masjid (atomic JSON writes; dedupes by instagram_shortcode).
            insta_cmd.extend(["--days", "365", "--post-count", "40", "--atomic-scrape", "--sleep-seconds", sleep])
        run_instagram_scrape(insta_cmd, run_env)
    run([PY, "enrich_all_masjids.py"], extra_env=run_env)
    # Guarantee weekly Jumu'ah for every masjid — even when scrapers + IG fail — by
    # topping up the merged TARGET_ALL / TARGET_FUTURE files before downstream consumers run.
    run([PY, "ensure_synthetic_jummah.py"], extra_env=run_env)
    if not fast_mode:
        # Heavy poster audit is kept off the critical 3x/day fast path.
        run([PY, "audit_posters.py"], extra_env=run_env)
    run([PY, "build_event_dashboard.py"], extra_env=run_env)
    run([PY, "generate_source_health_dashboard.py"], extra_env=run_env)
    run([PY, "sync_supabase_events.py"], extra_env=run_env)

    sync_db(DB_ALL, TARGET_ALL)
    sync_db(DB_FUTURE, TARGET_FUTURE)
    # Keep this mirror current for any existing consumers.
    save_json(TARGET_DETAILED, load_json(TARGET_FUTURE))

    # Offline-first: ship a fresh snapshot of events + meta inside the mobile app
    # bundle so launch-time UX never waits on the network.
    write_mobile_seed()

    update_index()
    mode = "fast" if fast_mode else "full"
    total_s = round(time.perf_counter() - pipeline_started, 2)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_path = REPORT_DIR / f"pipeline_run_{stamp}.json"
    report_path.write_text(
        json.dumps(
            {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "mode": mode,
                "total_duration_s": total_s,
                "steps": PIPELINE_STEPS,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[done] Safar daily pipeline complete ({mode} mode) in {total_s}s report={report_path}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"[error] command failed: {exc}")
        sys.exit(1)
