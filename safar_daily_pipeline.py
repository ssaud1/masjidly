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
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

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
_SCRAPER_FLAG_SUPPORT_CACHE: Dict[str, bool] = {}


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


def scraper_supports_flag(flag: str) -> bool:
    """Detect scraper CLI flags across mixed script versions."""
    if flag in _SCRAPER_FLAG_SUPPORT_CACHE:
        return _SCRAPER_FLAG_SUPPORT_CACHE[flag]
    try:
        probe = subprocess.run(
            [PY, "scrape_nj_masjid_instagram.py", "--help"],
            cwd=str(ROOT),
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        text = (probe.stdout or "") + "\n" + (probe.stderr or "")
        supported = flag in text
    except Exception:
        supported = False
    _SCRAPER_FLAG_SUPPORT_CACHE[flag] = supported
    return supported


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


def _maybe_refresh_proxifly_proxy_file() -> None:
    """
    If SAFAR_PROXIFLY_REFRESH is truthy, download Proxifly CDN proxies into
    SAFAR_INSTAGRAM_PROXY_FILE (default proxifly_proxies.txt) before the scraper runs.
    """
    flag = os.getenv("SAFAR_PROXIFLY_REFRESH", "").strip().lower()
    if flag not in {"1", "true", "yes"}:
        return
    out_raw = os.getenv("SAFAR_INSTAGRAM_PROXY_FILE", "proxifly_proxies.txt").strip() or "proxifly_proxies.txt"
    out = Path(out_raw)
    if not out.is_absolute():
        out = ROOT / out
    try:
        max_lines = int(os.getenv("SAFAR_PROXIFLY_MAX", "40").strip() or "40")
    except ValueError:
        max_lines = 40
    list_url = os.getenv("SAFAR_PROXIFLY_LIST_URL", "").strip() or None
    try:
        import proxifly_fetch as _pf

        n = _pf.refresh_proxifly_proxy_file(out, list_url, max_lines)
        print(f"[proxifly] refreshed {n} proxy line(s) -> {out}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] Proxifly refresh failed (continuing without refresh): {exc}", flush=True)


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
    _maybe_refresh_proxifly_proxy_file()
    proxy_lines = load_instagram_proxy_lines()
    try:
        shards = max(1, int(os.getenv("SAFAR_INSTAGRAM_SHARDS", "1").strip() or "1"))
    except ValueError:
        shards = 1
    raw_names = os.getenv("SAFAR_INSTAGRAM_USERNAMES", "").strip()
    if raw_names:
        names = [x.strip() for x in raw_names.split(",") if x.strip()]
        if not names:
            names = list(IG_DEFAULT_USERNAMES)
    else:
        names = list(IG_DEFAULT_USERNAMES)
    n = len(names)
    allow_single_ip_shards = os.getenv("SAFAR_INSTAGRAM_SHARDS_NO_PROXY", "0").strip() == "1"
    if shards > 1 and not proxy_lines and not allow_single_ip_shards:
        print("[warn] SAFAR_INSTAGRAM_SHARDS>1 without SAFAR_INSTAGRAM_PROXY_FILE can overload one IP; forcing shards=1.")
        print("[hint] Set SAFAR_INSTAGRAM_SHARDS_NO_PROXY=1 only when you explicitly want faster single-IP sharding.")
        shards = 1
    elif shards > 1 and not proxy_lines and allow_single_ip_shards:
        print(
            "[warn] Running Instagram shards on a single IP (SAFAR_INSTAGRAM_SHARDS_NO_PROXY=1). "
            "This is faster but may increase temporary throttling.",
            flush=True,
        )
    if shards > n:
        shards = n
    if shards <= 1:
        cmd = base_cmd + ["--usernames"] + names
        # Match the original working scraper: direct connection by default.
        # Only route through a Webshare proxy if the operator explicitly opts in
        # via SAFAR_INSTAGRAM_FORCE_PROXY=1 (useful as a fallback when the raw
        # runner IP gets flagged by Instagram).
        force_proxy = os.getenv("SAFAR_INSTAGRAM_FORCE_PROXY", "0").strip() == "1"
        if proxy_lines and force_proxy:
            if len(proxy_lines) >= 2:
                pool_path = ROOT / "_instagram_proxy_pool.txt"
                pool_path.write_text("\n".join(proxy_lines) + "\n", encoding="utf-8")
                cmd.extend(["--proxy-file", str(pool_path)])
                print(
                    f"[run] IG serial mode via proxy pool ({len(proxy_lines)} lines) "
                    f"file={pool_path.name} (rotates on HTTP 401/403)",
                    flush=True,
                )
            else:
                cmd.extend(["--proxy", proxy_lines[0]])
                print(
                    f"[run] IG serial mode via forced proxy {_log_cmd_redact_proxy([proxy_lines[0]])}",
                    flush=True,
                )
        else:
            print(
                "[run] IG serial mode, direct connection (no proxy; matches original "
                "working script). Set SAFAR_INSTAGRAM_FORCE_PROXY=1 to route through Webshare.",
                flush=True,
            )
        print("[run]", _log_cmd_redact_proxy(cmd), flush=True)
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

    # Stagger shard start-times so all N profile-info / feed requests don't
    # fire simultaneously through different Webshare proxies (Instagram flags
    # bursty IP-rotation patterns even when the per-IP rate is low). Default
    # 15s between shards. Set to 0 to disable.
    try:
        stagger_s = max(0.0, float(os.getenv("SAFAR_INSTAGRAM_SHARD_STAGGER_SECONDS", "15").strip() or "15"))
    except ValueError:
        stagger_s = 15.0

    def _run_shard(pair: Tuple[int, List[str]]) -> None:
        shard_idx, sub = pair
        if stagger_s > 0 and shard_idx > 0:
            delay = stagger_s * shard_idx
            print(
                f"[run.instagram.parallel] shard={shard_idx} staggering start "
                f"by {delay:.1f}s accounts={len(sub)}",
                flush=True,
            )
            time.sleep(delay)
        cmd = base_cmd + ["--usernames"] + sub
        if proxy_lines:
            px = proxy_lines[shard_idx % len(proxy_lines)]
            cmd.extend(["--proxy", px])
        print(
            f"[run.instagram.parallel] shard={shard_idx} START accounts={len(sub)} "
            f"cmd={_log_cmd_redact_proxy(cmd)}",
            flush=True,
        )
        t_shard = time.perf_counter()
        subprocess.run(cmd, cwd=str(ROOT), check=True, env=env_base)
        print(
            f"[run.instagram.parallel] shard={shard_idx} DONE "
            f"elapsed={round(time.perf_counter() - t_shard, 1)}s",
            flush=True,
        )

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


def _apply_seed_weekday_overrides(events: list) -> None:
    """Mirror the backend's weekday_overrides.json rules onto the bundled seed
    so offline/cold-start data matches what the API will serve. Shifts any
    matching event's `date` by the rule's weekday_shift_days. Safe no-op if the
    overrides file is missing or malformed.
    """
    from datetime import date as _date, timedelta as _td

    ov_path = Path(__file__).resolve().parent / "weekday_overrides.json"
    try:
        raw = json.loads(ov_path.read_text(encoding="utf-8"))
    except Exception:
        return
    rules = raw.get("overrides", []) if isinstance(raw, dict) else []
    norm = []
    for r in rules:
        if not isinstance(r, dict):
            continue
        src = (r.get("source") or "").strip().lower()
        tc = (r.get("title_contains") or "").strip().lower()
        try:
            shift = int(r.get("weekday_shift_days", 0))
        except Exception:
            shift = 0
        if src and tc and shift:
            norm.append((src, tc, shift))
    if not norm:
        return
    fixed = 0
    for e in events:
        src = (e.get("source") or "").strip().lower()
        title = (e.get("title") or "").strip().lower()
        for rule_src, rule_tc, rule_shift in norm:
            if rule_src != src or rule_tc not in title:
                continue
            iso = (e.get("date") or "").strip()
            try:
                y, m, dd = [int(x) for x in iso.split("-")]
                new_d = _date(y, m, dd) + _td(days=rule_shift)
                e["date"] = new_d.isoformat()
                fixed += 1
            except Exception:
                pass
            break
    if fixed:
        print(f"[seed] applied {fixed} weekday-override shifts")


_SEED_EVENT_KEYWORD_RE = re.compile(
    r"\b("
    r"tafsir|tafseer|seerah|sirah|hadith|quran|qur'an|tajweed|halaqa|dars|khatira|khutbah|"
    r"lecture|talk|workshop|seminar|series|program|class|course|night|retreat|conference|fundraiser"
    r")\b",
    flags=re.I,
)
_SEED_GENERIC_BAD_PHRASE_RE = re.compile(
    r"\b("
    r"we hope to see you|see you all there|insha'?allah|will you attend|official rsvp|"
    r"add to my device calendar|be the first from your circle|bring a friend|"
    r"\d+\s+likes?,?\s*\d+\s+comments?"
    r")\b",
    flags=re.I,
)


def _clean_seed_title_text(raw: str) -> str:
    s = re.sub(r"\s+", " ", raw or "").strip()
    return s.strip("\"'` ")


def _is_caption_style_title(raw: str) -> bool:
    s = _clean_seed_title_text(raw).lower()
    if not s:
        return True
    words = len(s.split())
    has_event_keyword = bool(_SEED_EVENT_KEYWORD_RE.search(s))
    has_speaker_context = bool(re.search(r"\b(with|by)\s+(sh\.?|shaykh|sheikh|imam|ustadh|dr\.?)\b", s))
    if s.startswith("/") or s.startswith("\\"):
        return True
    if _SEED_GENERIC_BAD_PHRASE_RE.search(s):
        return True
    if re.search(r"\b(register|rsvp|follow|link in bio|swipe|tickets?|www\.|https?://|#\w+)\b", s):
        if words <= 16 or len(s) > 80:
            return True
    if len(s) > 95:
        return True
    if len(s) > 72 and re.search(r"\b(join us|details|who\?|when\?|where\?)\b", s):
        if has_event_keyword and has_speaker_context:
            return False
        return True
    return False


def _score_seed_title_candidate(raw: str) -> int:
    s = _clean_seed_title_text(raw)
    low = s.lower()
    if not s:
        return -999
    if len(s) < 8 or len(s) > 110:
        return -999
    if _is_caption_style_title(s):
        return -999
    words = len(s.split())
    score = 0
    if _SEED_EVENT_KEYWORD_RE.search(s):
        score += 8
    if re.search(r"\b(with|by)\s+(sh\.?|shaykh|sheikh|imam|ustadh|dr\.?)\b", s, flags=re.I):
        score += 5
    if 3 <= words <= 14:
        score += 2
    if words > 20:
        score -= 4
    if re.search(r"\bpresents?\b", low) and ":" not in s and words <= 7:
        score -= 4
    if re.search(r"\b(mon|tue|wed|thu|fri|sat|sun)\b", low) and re.search(r"\b\d{1,2}:\d{2}\s*(am|pm)\b", low):
        score -= 3
    return score


def _derive_seed_title_from_event(event: Dict[str, Any]) -> str:
    title = _clean_seed_title_text(str(event.get("title", "")))
    desc = _clean_seed_title_text(str(event.get("description", "")))
    raw_text = _clean_seed_title_text(str(event.get("raw_text", "")))
    ocr_text = _clean_seed_title_text(str(event.get("poster_ocr_text", "")))
    blob = "\n".join([desc, raw_text, ocr_text]).strip()
    if not blob:
        return title

    candidates: List[str] = []
    featured = re.search(
        r"\b(tafsi(?:r|er)\s+series\s+with\s+(?:sh\.?|shaykh|sheikh|imam|ustadh|dr\.?)\s*[^,.!?]{2,70})",
        blob,
        flags=re.I,
    )
    if featured:
        candidates.append(_clean_seed_title_text(featured.group(1)))

    for line in re.split(r"[\n.!?]+", blob):
        s = _clean_seed_title_text(line)
        if s:
            candidates.append(s)

    # If a line looks like "X presents: Y", prefer Y.
    for line in list(candidates):
        m = re.search(r"\bpresents?\s*:\s*(.+)$", line, flags=re.I)
        if m:
            candidates.append(_clean_seed_title_text(m.group(1)))

    best = title
    best_score = _score_seed_title_candidate(title)
    for cand in candidates:
        sc = _score_seed_title_candidate(cand)
        if sc > best_score:
            best_score = sc
            best = cand
    return best


def _normalize_seed_event_titles(events: List[Dict[str, Any]]) -> None:
    """Fix weak/caption-style titles before writing mobile seed JSON."""
    changed = 0
    for e in events:
        old = _clean_seed_title_text(str(e.get("title", "")))
        if not old:
            continue
        if not _is_caption_style_title(old):
            continue
        new_title = _derive_seed_title_from_event(e)
        if new_title and new_title != old and not _is_caption_style_title(new_title):
            e["title"] = new_title
            changed += 1
    if changed:
        print(f"[seed] normalized {changed} caption-style title(s)")


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

    _apply_seed_weekday_overrides(future)
    _normalize_seed_event_titles(future)

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
        ig_skip_recent = os.getenv("SAFAR_INSTAGRAM_SKIP_RECENT_HOURS", "").strip()
        supports_max_pages = scraper_supports_flag("--max-pages")
        if fast_mode:
            sleep = ig_sleep or "1.4"
            insta_cmd.extend(["--days", "60", "--post-count", "30"])
            if supports_max_pages:
                insta_cmd.extend(["--max-pages", "36"])
            insta_cmd.extend(["--atomic-scrape", "--sleep-seconds", sleep])
        else:
            sleep = ig_sleep or "3.0"
            # Download → local OCR → single merge per masjid (atomic JSON writes; dedupes by instagram_shortcode).
            insta_cmd.extend(["--days", "365", "--post-count", "40"])
            if supports_max_pages:
                insta_cmd.extend(["--max-pages", "96"])
            insta_cmd.extend(["--atomic-scrape", "--sleep-seconds", sleep])
        if ig_skip_recent:
            insta_cmd.extend(["--skip-recent-hours", ig_skip_recent])
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

    # Refresh the YouTube archive for every clean speaker and backfill
    # baseline amenity rows on Railway.  Only on the full nightly run —
    # the fast runs shouldn't spend minutes scraping YouTube.  This is a
    # best-effort step: if Railway is down or the secret isn't set we
    # log-and-continue instead of failing the whole pipeline.
    if not fast_mode and os.getenv("SAFAR_CRON_SECRET"):
        try:
            run([PY, "refresh_speaker_content.py"], extra_env=run_env)
        except subprocess.CalledProcessError as exc:
            print(f"[warn] refresh_speaker_content.py failed: {exc} (continuing)")

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
