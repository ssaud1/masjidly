#!/usr/bin/env python3
"""
Scrape NJ masjid Instagram accounts and merge event rows into Safar datasets.

Goals:
- Run alongside website + email ingestion (tandem).
- Handle Instagram throttling via exponential backoff.
- Preserve existing rows while adding unique Instagram-only rows.
- Emit comparison report showing what Instagram added beyond existing data.
- Ensure Jumu'ah appears as an upcoming event for each mapped masjid source.

Usage:
  .venv/bin/python scrape_nj_masjid_instagram.py
  .venv/bin/python scrape_nj_masjid_instagram.py --days 120 --post-count 80
  # Recommended: download → OCR posters → one merge into events (atomic file replace, no caption-only dupes).
  .venv/bin/python scrape_nj_masjid_instagram.py --usernames iceb.nj icpcnj --atomic-scrape
  # Legacy: merge immediately without local poster OCR.
  .venv/bin/python scrape_nj_masjid_instagram.py --usernames iceb.nj icpcnj --no-ocr
  .venv/bin/python scrape_nj_masjid_instagram.py --proxy http://127.0.0.1:8888
  # After a --no-ocr scrape, run Tesseract on saved posters and re-merge into datasets:
  .venv/bin/python scrape_nj_masjid_instagram.py --ocr-backfill

Auth (optional; helps with 429 / pagination when allowed by Meta policy):
  export IG_SESSIONID="..."
  export IG_CSRFTOKEN="..."   # often required together with sessionid

Rate limits (optional env):
  IG_REQUEST_RETRIES (default 12), IG_BACKOFF_BASE_S (default 2), IG_BACKOFF_CAP_S (default 120)

Feed pagination (optional env):
  IG_RESUME_FEED=1 — resume interrupted feed fetch using instagram/_cache/feed_<user>_<id>.json
  IG_CLEAR_FEED_CHECKPOINT=1 — delete that checkpoint before scraping the account
  IG_FEED_CHECKPOINT=1 — write checkpoint JSON after each page (for debugging; no resume)

Poster OCR languages:
  SAFAR_TESSERACT_LANG — default eng; try eng+ara for bilingual flyers if traineddata is installed

Raw API payloads (large JSON per post):
  .venv/bin/python scrape_nj_masjid_instagram.py --save-raw-api --no-ocr ...
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass, replace
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, urlparse

import dateparser
import requests

ROOT = Path("/Users/shaheersaud/Safar")
EVENTS_DIR = ROOT / "events_by_masjid"
REPORTS_DIR = EVENTS_DIR / "_reports"
OUTPUT_ROOT = ROOT / "instagram" / "output" / "nj_masjid_events"
IG_CACHE_DIR = ROOT / "instagram" / "_cache"
IG_ACCOUNT_STATE_PATH = IG_CACHE_DIR / "account_state.json"


def _load_account_state() -> Dict[str, Any]:
    if not IG_ACCOUNT_STATE_PATH.exists():
        return {}
    try:
        data = json.loads(IG_ACCOUNT_STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_account_state(state: Dict[str, Any]) -> None:
    IG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        IG_ACCOUNT_STATE_PATH.write_text(
            json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass


def _recently_scraped(state: Dict[str, Any], username: str, ttl_hours: float) -> bool:
    """True if the account was scraped successfully within the TTL window (skip to be nice to IG)."""
    if ttl_hours <= 0:
        return False
    rec = state.get(username) or {}
    ts = rec.get("last_success_utc")
    if not ts:
        return False
    try:
        when = dt.datetime.fromisoformat(ts)
        if when.tzinfo is None:
            when = when.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return False
    return (dt.datetime.now(dt.timezone.utc) - when).total_seconds() < ttl_hours * 3600.0


def _mark_account_result(
    state: Dict[str, Any],
    username: str,
    success: bool,
    count: int,
    note: str = "",
) -> None:
    rec = state.get(username) or {}
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    if success:
        rec["last_success_utc"] = now_iso
        rec["last_count"] = count
        rec["last_note"] = note or "ok"
    else:
        rec["last_failure_utc"] = now_iso
        rec["last_note"] = note or "failed"
    state[username] = rec


def _feed_checkpoint_path(username: str, user_id: str) -> Path:
    IG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return IG_CACHE_DIR / f"feed_{username}_{user_id}.json"


def _load_feed_checkpoint(username: str, user_id: str) -> Tuple[set, Optional[str]]:
    """When IG_RESUME_FEED=1, restore pagination cursor + seen media PKs from last run."""
    if os.environ.get("IG_RESUME_FEED", "").strip() != "1" or not username:
        return set(), None
    p = _feed_checkpoint_path(username, user_id)
    if not p.exists():
        return set(), None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        seen = {str(x) for x in (data.get("seen_pks") or [])}
        return seen, data.get("next_max_id") or None
    except Exception:
        return set(), None


def _write_feed_checkpoint(
    username: str,
    user_id: str,
    seen: set,
    next_max_id: Optional[str],
) -> None:
    p = _feed_checkpoint_path(username, user_id)
    p.write_text(
        json.dumps(
            {
                "username": username,
                "user_id": user_id,
                "next_max_id": next_max_id,
                "seen_pks": sorted(seen),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def normalize_proxy_line(raw: str) -> str:
    """
    Accept full proxy URLs, or Webshare-style lines: host:port:username:password
    (IPv4 host). Returns an http:// URL suitable for requests.
    """
    s = re.sub(r"\s+", "", (raw or "").strip())
    if not s or s.startswith("#"):
        return ""
    if "://" in s:
        return s
    parts = s.split(":")
    if len(parts) < 4:
        return ""
    host, port, user = parts[0], parts[1], parts[2]
    password = ":".join(parts[3:])
    if not port.isdigit():
        return ""
    return f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"


DEFAULT_USERNAMES = [
    "icpcnj",
    "mcmcnj",
    "iscj_official",
    "mcgprinceton",
    "iceb.nj",
    "nbic_pics",
    "alfalahcenternj",
    "darul.islah",
    "masjidalwali",
    "icsjmasjid",
    "masjidmuhammadnewark",
    "icucnj",
    "masjid_al_aman",
    "mcnjonline",
    "icnanj",
    "jmicnj",
    "icmcnj",
    "icoconline",
    "bayonnemasjid",
    "hudsonislamic",
    "islamiccenterofclifton",
    "isbcnj",
    "muslimcenterjerseycity",
    "masjidwaarithuddeen",
]

# username -> source key + organizer/location metadata
SOURCE_MAP: Dict[str, Dict[str, str]] = {
    "icpcnj": {
        "source": "icpc",
        "organizer": "Islamic Center of Passaic County",
        "location_name": "Islamic Center of Passaic County",
        "address": "152 Derrom Ave, Paterson, NJ 07504",
        "city": "Paterson",
        "state": "NJ",
        "zip": "07504",
    },
    "mcmcnj": {
        "source": "mcmc",
        "organizer": "Muslim Center of Middlesex County",
        "location_name": "Muslim Center of Middlesex County",
        "address": "1000 Hoes Ln, Piscataway, NJ 08854",
        "city": "Piscataway",
        "state": "NJ",
        "zip": "08854",
    },
    "iscj_official": {
        "source": "iscj",
        "organizer": "Islamic Society of Central Jersey",
        "location_name": "Islamic Society of Central Jersey",
        "address": "4145 US-1, Monmouth Junction, NJ 08852",
        "city": "Monmouth Junction",
        "state": "NJ",
        "zip": "08852",
    },
    "mcgprinceton": {
        "source": "mcgp",
        "organizer": "Muslim Center of Greater Princeton",
        "location_name": "Muslim Center of Greater Princeton",
        "address": "2030 Old Trenton Rd, West Windsor, NJ 08550",
        "city": "West Windsor",
        "state": "NJ",
        "zip": "08550",
    },
    "iceb.nj": {
        "source": "iceb",
        "organizer": "Islamic Center of East Brunswick",
        "location_name": "Islamic Center of East Brunswick",
        "address": "402 New Brunswick Ave, East Brunswick, NJ 08816",
        "city": "East Brunswick",
        "state": "NJ",
        "zip": "08816",
    },
    "nbic_pics": {
        "source": "nbic",
        "organizer": "New Brunswick Islamic Center",
        "location_name": "New Brunswick Islamic Center",
        "address": "1330 Livingston Ave Unit 4, North Brunswick, NJ 08902",
        "city": "North Brunswick",
        "state": "NJ",
        "zip": "08902",
    },
    "alfalahcenternj": {
        "source": "alfalah",
        "organizer": "Al Falah Center",
        "location_name": "Al Falah Center",
        "address": "15 Grove St, Somerset, NJ 08873",
        "city": "Somerset",
        "state": "NJ",
        "zip": "08873",
    },
    "darul.islah": {
        "source": "darul_islah",
        "organizer": "Darul Islah",
        "location_name": "Darul Islah",
        "address": "202-206 James St, Teaneck, NJ 07666",
        "city": "Teaneck",
        "state": "NJ",
        "zip": "07666",
    },
    "masjidalwali": {
        "source": "masjid_al_wali",
        "organizer": "Masjid Al-Wali",
        "location_name": "Masjid Al-Wali",
        "address": "421 New Dover Rd, Edison, NJ 08820",
        "city": "Edison",
        "state": "NJ",
        "zip": "08820",
    },
    "icsjmasjid": {
        "source": "icsj",
        "organizer": "Islamic Center of South Jersey",
        "location_name": "Islamic Center of South Jersey",
        "address": "4145 Evesham Rd, Voorhees Township, NJ 08043",
        "city": "Voorhees Township",
        "state": "NJ",
        "zip": "08043",
    },
    "masjidmuhammadnewark": {
        "source": "masjid_muhammad_newark",
        "organizer": "Masjid Muhammad Newark",
        "location_name": "Masjid Muhammad Newark",
        "address": "257 S Orange Ave, Newark, NJ 07103",
        "city": "Newark",
        "state": "NJ",
        "zip": "07103",
    },
    "icucnj": {
        "source": "icuc",
        "organizer": "Islamic Center of Union County",
        "location_name": "Islamic Center of Union County",
        "address": "2372 Morris Ave, Union, NJ 07083",
        "city": "Union",
        "state": "NJ",
        "zip": "07083",
    },
    "masjid_al_aman": {
        "source": "ismc",
        "organizer": "Islamic Society of Monmouth County",
        "location_name": "Masjid Al-Aman (ISMCNJ)",
        "address": "496 Red Hill Rd, Middletown, NJ 07748",
        "city": "Middletown",
        "state": "NJ",
        "zip": "07748",
    },
    "mcnjonline": {
        "source": "mcnj",
        "organizer": "Muslim Community of New Jersey",
        "location_name": "MCNJ Masjid",
        "address": "15 S 2nd St, Fords, NJ 08863",
        "city": "Fords",
        "state": "NJ",
        "zip": "08863",
    },
    "icnanj": {
        "source": "icna_nj",
        "organizer": "ICNA New Jersey",
        "location_name": "ICNA New Jersey",
        "address": "1320 Hamilton St, Somerset, NJ 08873",
        "city": "Somerset",
        "state": "NJ",
        "zip": "08873",
    },
    "jmicnj": {
        "source": "jmic",
        "organizer": "Jam-e-Masjid Islamic Center",
        "location_name": "Jam-e-Masjid Islamic Center",
        "address": "110 Harrison St, Boonton, NJ 07005",
        "city": "Boonton",
        "state": "NJ",
        "zip": "07005",
    },
    "icmcnj": {
        "source": "icmc",
        "organizer": "Islamic Center of Morris County",
        "location_name": "Islamic Center of Morris County",
        "address": "1 Mannino Dr, Rockaway, NJ 07866",
        "city": "Rockaway",
        "state": "NJ",
        "zip": "07866",
    },
    "icoconline": {
        "source": "icoc",
        "organizer": "Islamic Center of Ocean County",
        "location_name": "Islamic Center of Ocean County (Masjid Al-Mustafa)",
        "address": "2116 Whitesville Rd, Toms River, NJ 08755",
        "city": "Toms River",
        "state": "NJ",
        "zip": "08755",
    },
    "bayonnemasjid": {
        "source": "bayonne_mc",
        "organizer": "Bayonne Muslims Community Center",
        "location_name": "Bayonne Muslims Masjid",
        "address": "109 E 24th St, Bayonne, NJ 07002",
        "city": "Bayonne",
        "state": "NJ",
        "zip": "07002",
    },
    "hudsonislamic": {
        "source": "hudson_ic",
        "organizer": "Hudson Islamic Center",
        "location_name": "Hudson Islamic Center",
        "address": "1 Bergen Ave, Jersey City, NJ 07305",
        "city": "Jersey City",
        "state": "NJ",
        "zip": "07305",
    },
    "islamiccenterofclifton": {
        "source": "clifton_ic",
        "organizer": "Islamic Center of Clifton",
        "location_name": "Islamic Center of Clifton",
        "address": "124 Malone Ave, Clifton, NJ 07011",
        "city": "Clifton",
        "state": "NJ",
        "zip": "07011",
    },
    "isbcnj": {
        "source": "isbc",
        "organizer": "Islamic Society of Basking Ridge",
        "location_name": "Islamic Society of Basking Ridge",
        "address": "100 S Finley Ave, Basking Ridge, NJ 07920",
        "city": "Basking Ridge",
        "state": "NJ",
        "zip": "07920",
    },
    "muslimcenterjerseycity": {
        "source": "mcjc",
        "organizer": "Muslim Center of Jersey City",
        "location_name": "Muslim Center of Jersey City",
        "address": "47 Belmont Ave, Jersey City, NJ 07304",
        "city": "Jersey City",
        "state": "NJ",
        "zip": "07304",
    },
    "masjidwaarithuddeen": {
        "source": "waarith",
        "organizer": "Masjid Waarith ud Deen",
        "location_name": "Masjid Waarith ud Deen",
        "address": "4 Gifford Ln, Newark, NJ 07106",
        "city": "Newark",
        "state": "NJ",
        "zip": "07106",
    },
}

HEADERS = {
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest",
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
}

EVENT_KEYWORDS = [
    "event",
    "events",
    "join us",
    "rsvp",
    "register",
    "registration",
    "workshop",
    "lecture",
    "dars",
    "halaqa",
    "taraweeh",
    "iftar",
    "eid",
    "community",
    "open house",
    "competition",
    "night",
    "series",
    "program",
    "session",
    "when",
    "where",
    "time",
    "location",
    "friday",
    "jumu",
    "jumma",
    "khutbah",
]

URL_RE = re.compile(r"https?://[^\s)]+")
TIME_RE = re.compile(
    r"\b\d{1,2}(?::\d{2})?\s?(?:AM|PM|am|pm)\b(?:\s?[–\-to]{1,3}\s?\d{1,2}(?::\d{2})?\s?(?:AM|PM|am|pm)\b)?"
)
MONTH = (
    "January|February|March|April|May|June|July|August|"
    "September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
)
DATE_RE = re.compile(
    rf"\b(?:{MONTH})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,\s*\d{{2,4}})?\b|\b\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?\b",
    re.I,
)
WEEKDAY_RE = re.compile(r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b", re.I)
LOCATION_RE = re.compile(r"\b(?:Location|Where)\s*[:\-]\s*([^\n]+)", re.I)
EVENT_KEYWORD_RE = re.compile("|".join(re.escape(k) for k in EVENT_KEYWORDS), re.I)


@dataclass
class EventRecord:
    username: str
    shortcode: str
    post_url: str
    poster_path: str
    poster_url: str
    posted_at_utc: str
    title: str
    dates: List[str]
    times: List[str]
    location: str
    rsvp_url: str
    caption: str
    ocr_text: str
    # Full API payload when --save-raw-api (for offline processing / debugging).
    raw_api_item: Optional[Dict[str, Any]] = None


def now_stamp() -> str:
    return f"{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def first_non_empty_line(text: str) -> str:
    for line in (text or "").splitlines():
        candidate = line.strip(" *•-\t")
        if len(candidate) >= 6:
            return candidate
    return ""


def normalize_unique(values: Iterable[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for raw in values:
        value = clean_spaces(raw)
        if not value:
            continue
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _ig_json_retry_settings() -> Tuple[int, float, float]:
    """(retries, exponential_base_s, max_sleep_cap_s) — tunable via env.

    Defaults tuned for "keep the pipeline moving" instead of "wait forever for one account"."""
    retries = max(1, int(os.environ.get("IG_REQUEST_RETRIES", "6")))
    base = max(0.2, float(os.environ.get("IG_BACKOFF_BASE_S", "1.5")))
    cap = max(base, float(os.environ.get("IG_BACKOFF_CAP_S", "45")))
    return retries, base, cap


def _retry_after_seconds(response: requests.Response) -> Optional[float]:
    h = (response.headers.get("Retry-After") or response.headers.get("retry-after") or "").strip()
    if not h:
        return None
    try:
        return max(0.0, float(h))
    except ValueError:
        try:
            when = parsedate_to_datetime(h)
            if when.tzinfo is None:
                when = when.replace(tzinfo=dt.timezone.utc)
            return max(0.0, (when - dt.datetime.now(dt.timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def request_json(session: requests.Session, url: str, timeout_s: int = 35) -> dict:
    retries, base_sleep_s, cap_sleep = _ig_json_retry_settings()
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            response = session.get(url, timeout=timeout_s)
            if response.status_code in (429, 500, 502, 503, 504):
                if attempt < retries - 1:
                    if response.status_code == 429:
                        ra = _retry_after_seconds(response)
                        if ra is not None:
                            wait_s = min(cap_sleep, ra + random.uniform(0.15, 2.0))
                        else:
                            wait_s = min(
                                cap_sleep,
                                base_sleep_s * (2 ** attempt) + random.uniform(0.0, 1.5),
                            )
                    else:
                        wait_s = min(
                            cap_sleep,
                            base_sleep_s * (2 ** attempt) + random.uniform(0.0, 1.2),
                        )
                    path_hint = urlparse(url).path
                    if len(path_hint) > 80:
                        path_hint = path_hint[:80] + "…"
                    print(
                        f"[INFO] Instagram HTTP {response.status_code} on {path_hint} "
                        f"sleeping {wait_s:.1f}s (attempt {attempt + 1}/{retries})"
                    )
                    time.sleep(wait_s)
                    continue
                raise RuntimeError(f"instagram_throttle_or_upstream_{response.status_code}")
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            last_error = exc
            if attempt < retries - 1:
                wait_s = min(cap_sleep, base_sleep_s * (2 ** attempt) + random.uniform(0.0, 1.0))
                time.sleep(wait_s)
    if last_error:
        raise last_error
    raise RuntimeError("Failed to fetch JSON")


def warm_session(session: requests.Session) -> None:
    """Hit the IG homepage once so requests inherits csrftoken/mid cookies that unblock some endpoints."""
    try:
        session.get("https://www.instagram.com/", timeout=20)
        csrftoken = session.cookies.get("csrftoken", domain=".instagram.com") or session.cookies.get("csrftoken")
        if csrftoken and "x-csrftoken" not in session.headers:
            session.headers["x-csrftoken"] = csrftoken
    except Exception:
        pass


def _extract_user_from_html(html: str) -> Optional[dict]:
    """Parse an IG profile HTML page and return a dict shaped roughly like web_profile_info's user."""
    try:
        m = re.search(r'"user":(\{.+?\}),"gate"', html)
        if m:
            user = json.loads(m.group(1))
            if isinstance(user, dict) and user.get("id"):
                return user
    except Exception:
        pass
    try:
        m = re.search(r'"profile_id":"(\d+)"', html)
        uid = m.group(1) if m else None
        if not uid:
            m = re.search(r'"owner":\{"id":"(\d+)"', html)
            uid = m.group(1) if m else None
        if uid:
            return {"id": uid, "is_private": False, "edge_owner_to_timeline_media": {"edges": []}}
    except Exception:
        pass
    return None


def get_user_profile(session: requests.Session, username: str) -> Optional[dict]:
    url = (
        "https://www.instagram.com/api/v1/users/web_profile_info/"
        f"?username={quote(username, safe='')}"
    )
    try:
        data = request_json(session, url)
        user = (data.get("data") or {}).get("user")
        if isinstance(user, dict) and user.get("id"):
            return user
    except Exception as exc:
        print(f"[INFO] {username}: web_profile_info blocked ({exc}); trying HTML profile fallback")

    try:
        html_resp = session.get(
            f"https://www.instagram.com/{quote(username, safe='')}/",
            timeout=25,
        )
        if html_resp.status_code == 200 and html_resp.text:
            user = _extract_user_from_html(html_resp.text)
            if user:
                print(f"[INFO] {username}: HTML profile fallback succeeded (id={user.get('id')})")
                return user
    except Exception as exc:
        print(f"[WARN] {username}: HTML profile fallback failed ({exc})")
    return None


def fetch_all_posts_for_user(
    session: requests.Session,
    user_id: str,
    max_pages: int = 120,
    count_per_page: int = 40,
    sleep_seconds: float = 1.0,
    username: str = "",
) -> List[dict]:
    ck_write = bool(
        username
        and (
            os.environ.get("IG_FEED_CHECKPOINT", "").strip() == "1"
            or os.environ.get("IG_RESUME_FEED", "").strip() == "1"
        )
    )
    seen, resume_max = _load_feed_checkpoint(username, user_id) if username else (set(), None)
    all_items: List[dict] = []
    next_max_id: Optional[str] = resume_max
    success = False
    try:
        for page_idx in range(max_pages):
            url = f"https://www.instagram.com/api/v1/feed/user/{user_id}/?count={max(1, min(50, count_per_page))}"
            if next_max_id:
                url += "&max_id=" + quote(next_max_id, safe="")
            payload = request_json(session, url)
            batch = payload.get("items") or []
            if not batch:
                print(f"[instagram] @{username} page={page_idx + 1} empty_batch -> stop", flush=True)
                break
            new_count = 0
            for item in batch:
                pk = str(item.get("pk") or "")
                if not pk or pk in seen:
                    continue
                seen.add(pk)
                all_items.append(item)
                new_count += 1
            print(
                f"[instagram] @{username} page={page_idx + 1} batch={len(batch)} "
                f"new={new_count} total={len(all_items)} "
                f"more_available={bool(payload.get('more_available'))}",
                flush=True,
            )
            if new_count == 0:
                break
            if not payload.get("more_available"):
                break
            next_max_id = payload.get("next_max_id")
            if not next_max_id:
                break
            if ck_write:
                _write_feed_checkpoint(username, user_id, seen, next_max_id)
            if sleep_seconds > 0:
                time.sleep(sleep_seconds)
        success = True
    finally:
        if username and ck_write and success:
            try:
                _feed_checkpoint_path(username, user_id).unlink(missing_ok=True)
            except OSError:
                pass
    return all_items


def fetch_first_page_nodes(session: requests.Session, username: str) -> List[dict]:
    profile = get_user_profile(session, username)
    if not profile:
        return []
    timeline = profile.get("edge_owner_to_timeline_media") or {}
    edges = timeline.get("edges") or []
    nodes: List[dict] = []
    for edge in edges:
        node = (edge or {}).get("node") or {}
        if node:
            nodes.append(node)
    return nodes


def pick_poster_url(item: dict) -> Optional[str]:
    if item.get("__kind") == "node":
        return item.get("display_url") or item.get("thumbnail_src")
    candidates = ((item.get("image_versions2") or {}).get("candidates") or [])
    if candidates and isinstance(candidates[0], dict):
        return candidates[0].get("url")
    carousel = item.get("carousel_media") or []
    for media in carousel:
        media_candidates = ((media.get("image_versions2") or {}).get("candidates") or [])
        if media_candidates and isinstance(media_candidates[0], dict):
            return media_candidates[0].get("url")
    return None


def extract_caption(item: dict) -> str:
    if item.get("__kind") == "node":
        edges = ((item.get("edge_media_to_caption") or {}).get("edges") or [])
        if edges:
            return ((edges[0] or {}).get("node") or {}).get("text") or ""
        return ""
    return ((item.get("caption") or {}).get("text") or "").strip()


def extract_shortcode(item: dict) -> str:
    if item.get("__kind") == "node":
        return item.get("shortcode") or ""
    return item.get("code") or ""


def extract_posted_at(item: dict) -> Optional[dt.datetime]:
    ts = item.get("taken_at_timestamp") if item.get("__kind") == "node" else item.get("taken_at")
    if not ts:
        return None
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc)


def extract_event_fields(caption: str, ocr_text: str) -> Dict[str, object]:
    merged = (caption or "") + "\n" + (ocr_text or "")
    title = pick_flyer_title(caption, ocr_text)
    dates = normalize_unique(list(WEEKDAY_RE.findall(merged)) + list(DATE_RE.findall(merged)))
    times = normalize_unique([m.group(0) for m in TIME_RE.finditer(merged)])
    location = ""
    loc_match = LOCATION_RE.search(merged)
    if loc_match:
        location = clean_spaces(loc_match.group(1))
    links = normalize_unique([u.rstrip(".,") for u in URL_RE.findall(merged)])
    rsvp = ""
    for url in links:
        lower = url.lower()
        if any(token in lower for token in ["partiful", "forms.gle", "tinyurl", "rsvp", "register", "event"]):
            rsvp = url
            break
    if not rsvp and links:
        rsvp = links[0]
    return {"title": title, "dates": dates[:8], "times": times[:8], "location": location, "rsvp_url": rsvp}


def run_ocr(image_path: Path, txt_base_path: Path) -> str:
    """Run tesseract, but skip if we already have a non-empty cached .txt next to the image."""
    lang = clean_spaces(os.environ.get("SAFAR_TESSERACT_LANG", "eng")) or "eng"
    txt_path = txt_base_path.with_suffix(".txt")
    try:
        if (
            txt_path.exists()
            and image_path.exists()
            and txt_path.stat().st_mtime >= image_path.stat().st_mtime
            and txt_path.stat().st_size > 0
        ):
            return clean_spaces(txt_path.read_text(errors="ignore"))
    except OSError:
        pass
    subprocess.run(
        ["tesseract", str(image_path), str(txt_base_path), "-l", lang],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not txt_path.exists():
        return ""
    return clean_spaces(txt_path.read_text(errors="ignore"))


def pick_flyer_title(caption: str, ocr_text: str) -> str:
    """Prefer ALL-CAPS / long headline lines from OCR over the first short caption line."""
    def _score(line: str) -> Tuple[int, int, int]:
        raw = line.strip(" *•-\t:—")
        if len(raw) < 6 or len(raw) > 90:
            return (0, 0, 0)
        letters = sum(1 for c in raw if c.isalpha())
        if letters < 4:
            return (0, 0, 0)
        upper_ratio = sum(1 for c in raw if c.isupper()) / max(1, letters)
        noisy = bool(re.search(r"(http|www\.|@|#\w|\b(rsvp|register|join us|instagram)\b)", raw, re.I))
        penalty = 2 if noisy else 0
        return (int(upper_ratio * 10) - penalty, min(40, len(raw)), 1)

    best = ""
    best_score: Tuple[int, int, int] = (0, 0, 0)
    for blob in (ocr_text, caption):
        for line in (blob or "").splitlines():
            s = _score(line)
            if s > best_score:
                best_score = s
                best = clean_spaces(line.strip(" *•-\t:—"))
    if best:
        return best
    return first_non_empty_line(caption) or first_non_empty_line(ocr_text) or "Untitled event"


def parse_time_range(value: str) -> Tuple[str, str]:
    txt = clean_spaces(value)
    m = re.search(
        r"\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b",
        txt,
        flags=re.I,
    )
    if m:
        return clean_spaces(m.group(1)), clean_spaces(m.group(2))
    m2 = re.search(r"\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b", txt, flags=re.I)
    if m2:
        return clean_spaces(m2.group(1)), ""
    return "", ""


def parse_best_date_iso(dates: List[str], posted_at: dt.datetime) -> str:
    base = posted_at.replace(tzinfo=None)
    best: Optional[dt.datetime] = None
    for raw in dates:
        parsed = dateparser.parse(
            raw,
            settings={"PREFER_DATES_FROM": "future", "RELATIVE_BASE": base},
        )
        if not parsed:
            continue
        if parsed < base - dt.timedelta(days=180):
            continue
        if parsed > base + dt.timedelta(days=420):
            continue
        if best is None or parsed < best:
            best = parsed
    if best:
        return best.date().isoformat()
    return posted_at.date().isoformat()


def build_event_row(record: EventRecord, source_meta: Dict[str, str]) -> Dict:
    source = source_meta["source"]
    title_low = clean_spaces(record.title).lower()
    caption_blob = clean_spaces((record.caption or "") + " " + (record.ocr_text or "")).lower()
    category = ""
    audience = ""
    if re.search(r"\b(jumu|jumma|jummah|khutbah)\b", f"{title_low} {caption_blob}"):
        category = "jummah"
        audience = "general"
    elif re.search(r"\b(halaqa|dars|tafsir|quran)\b", f"{title_low} {caption_blob}"):
        category = "halaqa"
    elif re.search(r"\b(youth|teen|kids|children)\b", f"{title_low} {caption_blob}"):
        category = "youth"
        audience = "family"
    elif re.search(r"\b(workshop|seminar|class|lecture)\b", f"{title_low} {caption_blob}"):
        category = "education"
    if not audience:
        if re.search(r"\b(sisters|women|girls)\b", f"{title_low} {caption_blob}"):
            audience = "sisters"
        elif re.search(r"\b(brothers|men|boys)\b", f"{title_low} {caption_blob}"):
            audience = "brothers"
        elif re.search(r"\b(family|families|parents|kids)\b", f"{title_low} {caption_blob}"):
            audience = "family"
    posted_at = dt.datetime.fromisoformat(record.posted_at_utc)
    event_date = parse_best_date_iso(record.dates, posted_at)
    st, et = ("", "")
    if record.times:
        st, et = parse_time_range(record.times[0])
    if not st and category == "jummah":
        st = "After Dhuhr"

    return {
        "source": source,
        "source_type": "instagram",
        "source_url": record.post_url,
        "title": clean_spaces(record.title),
        "description": clean_spaces(record.caption)[:900],
        "date": event_date,
        "start_time": st,
        "end_time": et,
        "location_name": source_meta.get("location_name", ""),
        "address": source_meta.get("address", ""),
        "city": source_meta.get("city", ""),
        "state": source_meta.get("state", ""),
        "zip": source_meta.get("zip", ""),
        "category": category,
        "audience": audience,
        "organizer": source_meta.get("organizer", ""),
        "rsvp_link": clean_spaces(record.rsvp_url),
        "image_urls": [record.poster_path] if clean_spaces(record.poster_path) else ([record.poster_url] if record.poster_url else []),
        "raw_text": clean_spaces((record.caption or "") + " " + (record.ocr_text or ""))[:1700],
        "confidence": 0.77 if record.dates or st else 0.68,
        "speaker": "",
        "posted_at_utc": record.posted_at_utc,
        "instagram_username": record.username,
        "instagram_shortcode": record.shortcode,
    }


def json_sanitize(obj: Any) -> Any:
    """Make nested API objects JSON-safe for disk storage."""
    try:
        return json.loads(json.dumps(obj, default=str))
    except (TypeError, ValueError):
        return {}


def event_record_public_dict(rec: EventRecord) -> Dict[str, Any]:
    d = asdict(rec)
    if d.get("raw_api_item") is None:
        d.pop("raw_api_item", None)
    return d


def record_from_dict(row: Dict[str, Any]) -> EventRecord:
    raw = row.get("raw_api_item")
    return EventRecord(
        username=str(row.get("username", "")),
        shortcode=str(row.get("shortcode", "")),
        post_url=str(row.get("post_url", "")),
        poster_path=str(row.get("poster_path", "")),
        poster_url=str(row.get("poster_url", "")),
        posted_at_utc=str(row.get("posted_at_utc", "")),
        title=str(row.get("title", "")),
        dates=[str(x) for x in (row.get("dates") or [])],
        times=[str(x) for x in (row.get("times") or [])],
        location=str(row.get("location", "")),
        rsvp_url=str(row.get("rsvp_url", "")),
        caption=str(row.get("caption", "")),
        ocr_text=str(row.get("ocr_text", "")),
        raw_api_item=raw if isinstance(raw, dict) else None,
    )


def _instagram_row_preference_score(row: Dict) -> Tuple[int, float]:
    """Higher wins when collapsing duplicate instagram_shortcode rows."""
    raw_len = len(clean_spaces(str(row.get("raw_text", ""))))
    conf = float(row.get("confidence", 0) or 0.0)
    return raw_len, conf


def _instagram_row_is_preferred(a: Dict, b: Dict) -> bool:
    sa, ca = _instagram_row_preference_score(a)
    sb, cb = _instagram_row_preference_score(b)
    if sa != sb:
        return sa > sb
    if ca != cb:
        return ca > cb
    return clean_spaces(str(a.get("title", ""))) >= clean_spaces(str(b.get("title", "")))


def _strip_instagram_rows_for_shortcodes(
    existing_rows: List[Dict], source: str, shortcodes: set[str]
) -> List[Dict]:
    """Drop prior Instagram rows for the same masjid source + post shortcode before re-inserting."""
    if not shortcodes:
        return list(existing_rows)
    src_l = clean_spaces(source).lower()
    out: List[Dict] = []
    for e in existing_rows:
        if clean_spaces(str(e.get("source", ""))).lower() != src_l:
            out.append(e)
            continue
        st = clean_spaces(str(e.get("source_type", ""))).lower()
        sc = clean_spaces(str(e.get("instagram_shortcode", ""))).lower()
        if sc and sc in shortcodes and st == "instagram":
            continue
        out.append(e)
    return out


def merge_instagram_for_username(username: str, records: List[EventRecord]) -> Dict[str, object]:
    """Merge scraped / OCR-updated rows into events_by_masjid/{source}_events.json."""
    source_meta = SOURCE_MAP[username]
    source = source_meta["source"]
    ig_rows = [build_event_row(r, source_meta) for r in records]
    shortcodes = {clean_spaces(r.shortcode).lower() for r in records if clean_spaces(r.shortcode)}
    out_file = EVENTS_DIR / f"{source}_events.json"
    existing_rows = load_json(out_file)
    if not isinstance(existing_rows, list):
        existing_rows = []
    existing_before = len(existing_rows)
    filtered = _strip_instagram_rows_for_shortcodes(existing_rows, source, shortcodes)
    existing_keys = {identity_key(e) for e in filtered}
    candidate_rows = len(ig_rows)
    new_unique = [e for e in ig_rows if identity_key(e) not in existing_keys]
    merged_rows = dedupe_events(filtered + ig_rows)
    merged_rows = add_recurring_jummah(source, source_meta, merged_rows, username)
    merged_rows = dedupe_events(merged_rows)
    save_json(out_file, merged_rows)
    return {
        "source": source,
        "username": username,
        "existing_before": existing_before,
        "instagram_candidates": candidate_rows,
        "instagram_new_unique": len(new_unique),
        "existing_after_merge": len(merged_rows),
    }


def dedupe_events(rows: List[Dict]) -> List[Dict]:
    by_ig: Dict[Tuple[str, str], Dict] = {}
    rest: List[Dict] = []
    for e in rows:
        sc = clean_spaces(str(e.get("instagram_shortcode", ""))).lower()
        src = clean_spaces(str(e.get("source", ""))).lower()
        if sc:
            k = (src, sc)
            prev = by_ig.get(k)
            if prev is None or _instagram_row_is_preferred(e, prev):
                by_ig[k] = e
        else:
            rest.append(e)
    combined = list(by_ig.values()) + rest
    seen = set()
    out: List[Dict] = []
    for e in combined:
        key = (
            clean_spaces(str(e.get("source", ""))).lower(),
            clean_spaces(str(e.get("title", ""))).lower(),
            clean_spaces(str(e.get("date", ""))),
            clean_spaces(str(e.get("start_time", ""))).lower(),
            clean_spaces(str(e.get("source_url", ""))).lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or ""))
    return out


def identity_key(event: Dict) -> str:
    return "|".join(
        [
            clean_spaces(str(event.get("source", ""))).lower(),
            clean_spaces(str(event.get("title", ""))).lower(),
            clean_spaces(str(event.get("date", ""))),
            clean_spaces(str(event.get("start_time", ""))).lower(),
        ]
    )


def add_recurring_jummah(source: str, source_meta: Dict[str, str], existing_rows: List[Dict], username: str) -> List[Dict]:
    today = dt.date.today()
    future_jummah = [
        e
        for e in existing_rows
        if clean_spaces(str(e.get("source", ""))).lower() == source
        and (clean_spaces(str(e.get("date", ""))) >= today.isoformat())
        and re.search(
            r"\b(jumu|jumma|jummah|khutbah)\b",
            f"{clean_spaces(str(e.get('title', '')).lower())} {clean_spaces(str(e.get('category', '')).lower())}",
        )
    ]
    if future_jummah:
        return existing_rows

    next_friday = today + dt.timedelta(days=(4 - today.weekday()) % 7)
    synth_rows = []
    for i in range(10):
        d = (next_friday + dt.timedelta(days=7 * i)).isoformat()
        synth_rows.append(
            {
                "source": source,
                "source_type": "instagram_recurring",
                "source_url": f"https://www.instagram.com/{username}/",
                "title": "Jumu'ah Prayer & Khutbah",
                "description": "Weekly Jumu'ah reminder generated from masjid Instagram source presence.",
                "date": d,
                "start_time": "After Dhuhr",
                "end_time": "",
                "location_name": source_meta.get("location_name", ""),
                "address": source_meta.get("address", ""),
                "city": source_meta.get("city", ""),
                "state": source_meta.get("state", ""),
                "zip": source_meta.get("zip", ""),
                "category": "jummah",
                "audience": "general",
                "organizer": source_meta.get("organizer", ""),
                "rsvp_link": "",
                "image_urls": [],
                "raw_text": "Recurring Jumu'ah coverage row.",
                "confidence": 0.55,
                "speaker": "",
            }
        )
    return existing_rows + synth_rows


def scrape_account(
    session: requests.Session,
    username: str,
    days: int,
    post_count: int,
    output_root: Path,
    do_ocr: bool,
    sleep_seconds: float,
    save_raw_api: bool,
) -> List[EventRecord]:
    t_acct = time.perf_counter()
    print(f"[instagram] @{username} START (days={days} post_count={post_count} ocr={do_ocr})", flush=True)
    profile = get_user_profile(session, username)
    if not profile:
        print(f"[WARN] {username}: could not read profile info", flush=True)
        return []
    user_id = str(profile.get("id") or "")
    is_private = bool(profile.get("is_private"))
    if not user_id or is_private:
        print(f"[WARN] {username}: skipped ({'private' if is_private else 'missing id'})", flush=True)
        return []

    used_fallback = False
    if os.environ.get("IG_CLEAR_FEED_CHECKPOINT", "").strip() == "1":
        try:
            _feed_checkpoint_path(username, user_id).unlink(missing_ok=True)
        except OSError:
            pass
    try:
        posts = fetch_all_posts_for_user(
            session=session,
            user_id=user_id,
            max_pages=160,
            count_per_page=post_count,
            sleep_seconds=sleep_seconds,
            username=username,
        )
    except Exception as exc:
        print(f"[WARN] {username}: full feed blocked ({exc}); using first page fallback", flush=True)
        nodes = fetch_first_page_nodes(session, username)
        posts = [{**node, "__kind": "node"} for node in nodes]
        used_fallback = True
    if not posts:
        print(f"[WARN] {username}: no posts fetched", flush=True)
        return []
    print(f"[instagram] @{username} fetched {len(posts)} posts from feed", flush=True)

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    account_root = output_root / username
    posters_dir = account_root / "posters"
    ocr_dir = account_root / "ocr"
    ensure_dir(posters_dir)
    ensure_dir(ocr_dir)

    records: List[EventRecord] = []
    kept = 0
    downloaded = 0
    ocr_runs = 0
    cache_hits = 0
    for idx, item in enumerate(posts):
        posted_at = extract_posted_at(item)
        if not posted_at or posted_at < cutoff:
            continue
        caption = extract_caption(item).strip()
        if not EVENT_KEYWORD_RE.search(caption):
            continue
        shortcode = extract_shortcode(item)
        if not shortcode:
            continue
        post_url = f"https://www.instagram.com/p/{shortcode}/"
        poster_url = pick_poster_url(item)
        if not poster_url:
            continue
        image_path = posters_dir / f"{shortcode}.jpg"
        if image_path.exists():
            cache_hits += 1
        else:
            try:
                r = session.get(poster_url, timeout=35)
                r.raise_for_status()
                image_path.write_bytes(r.content)
                downloaded += 1
            except Exception:
                continue
        ocr_text = ""
        if do_ocr:
            ocr_text = run_ocr(image_path, ocr_dir / shortcode)
            ocr_runs += 1
        kept += 1
        if kept % 5 == 0:
            print(
                f"[instagram] @{username} progress kept={kept} "
                f"downloaded={downloaded} ocr={ocr_runs} cache_hits={cache_hits} "
                f"scanned={idx + 1}/{len(posts)}",
                flush=True,
            )
        fields = extract_event_fields(caption, ocr_text)
        raw_blob: Optional[Dict[str, Any]] = json_sanitize(item) if save_raw_api else None
        records.append(
            EventRecord(
                username=username,
                shortcode=shortcode,
                post_url=post_url,
                poster_path=str(image_path.relative_to(ROOT)),
                poster_url=poster_url,
                posted_at_utc=posted_at.isoformat(),
                title=str(fields["title"]),
                dates=list(fields["dates"]),
                times=list(fields["times"]),
                location=str(fields["location"]),
                rsvp_url=str(fields["rsvp_url"]),
                caption=caption,
                ocr_text=ocr_text,
                raw_api_item=raw_blob,
            )
        )
        if sleep_seconds > 0:
            time.sleep(min(2.0, sleep_seconds * 0.5))

    records.sort(key=lambda x: x.posted_at_utc, reverse=True)
    if used_fallback:
        print(f"[WARN] {username}: first-page fallback only. Provide IG_SESSIONID for deeper pagination.", flush=True)
    elapsed = round(time.perf_counter() - t_acct, 1)
    print(
        f"[instagram] @{username} DONE  records={len(records)} "
        f"downloaded={downloaded} ocr={ocr_runs} cache_hits={cache_hits} "
        f"posts_scanned={len(posts)} elapsed={elapsed}s",
        flush=True,
    )
    return records


def apply_ocr_to_event_records(records: List[EventRecord], ocr_dir: Path) -> List[EventRecord]:
    """Run Tesseract on each downloaded poster and refresh derived title/date fields."""
    ensure_dir(ocr_dir)
    updated: List[EventRecord] = []
    for rec in records:
        rel = clean_spaces(rec.poster_path)
        if not rel:
            updated.append(rec)
            continue
        image_path = ROOT / rel
        if not image_path.is_file():
            updated.append(rec)
            continue
        ocr_text = run_ocr(image_path, ocr_dir / rec.shortcode)
        fields = extract_event_fields(rec.caption, ocr_text)
        updated.append(
            replace(
                rec,
                title=str(fields["title"]),
                dates=list(fields["dates"]),
                times=list(fields["times"]),
                location=str(fields["location"]),
                rsvp_url=str(fields["rsvp_url"]),
                ocr_text=ocr_text,
            )
        )
    return updated


def save_json(path: Path, data) -> None:
    """Write JSON atomically (temp file + replace) so readers never see a half-written file."""
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


def load_json(path: Path):
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []


def write_account_outputs(output_root: Path, stamp: str, username: str, records: List[EventRecord]) -> None:
    account_root = output_root / username
    ensure_dir(account_root)
    save_json(
        account_root / f"{username}_event_sections_{stamp}.json",
        {
            "username": username,
            "total_events": len(records),
            "events": [event_record_public_dict(x) for x in records],
        },
    )


def find_latest_event_sections_json(account_root: Path, username: str) -> Optional[Path]:
    candidates = list(account_root.glob(f"{username}_event_sections_*.json"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def run_ocr_backfill(usernames: List[str], output_root: Path, merge_events: bool) -> None:
    """
    Run Tesseract on downloaded poster images from the latest per-account sections JSON,
    refresh derived fields, write a new stamp file, and optionally re-merge into events_by_masjid.
    """
    stamp = now_stamp()
    compare_rows: List[Dict[str, object]] = []
    print(f"OCR backfill for {len(usernames)} accounts (merge_events={merge_events}) stamp={stamp}")
    for username in usernames:
        if username not in SOURCE_MAP:
            print(f"[WARN] {username}: not mapped in SOURCE_MAP, skipping")
            continue
        account_root = output_root / username
        latest = find_latest_event_sections_json(account_root, username)
        if not latest:
            print(f"[WARN] {username}: no {username}_event_sections_*.json under {account_root}")
            continue
        payload = load_json(latest)
        if not isinstance(payload, dict):
            print(f"[WARN] {username}: invalid sections JSON: {latest}")
            continue
        raw_events = payload.get("events") or []
        ocr_dir = account_root / "ocr"
        ensure_dir(ocr_dir)
        updated_rows: List[Dict[str, Any]] = []
        for row in raw_events:
            if not isinstance(row, dict):
                continue
            path_str = clean_spaces(str(row.get("poster_path", "")))
            shortcode = clean_spaces(str(row.get("shortcode", "")))
            caption = str(row.get("caption") or "")
            if not path_str or not shortcode:
                updated_rows.append(row)
                continue
            image_path = ROOT / path_str
            if not image_path.is_file():
                updated_rows.append(row)
                continue
            ocr_text = run_ocr(image_path, ocr_dir / shortcode)
            fields = extract_event_fields(caption, ocr_text)
            row = {
                **row,
                "ocr_text": ocr_text,
                "title": str(fields["title"]),
                "dates": list(fields["dates"]),
                "times": list(fields["times"]),
                "location": str(fields["location"]),
                "rsvp_url": str(fields["rsvp_url"]),
            }
            updated_rows.append(row)
        records = [record_from_dict(r) for r in updated_rows]
        write_account_outputs(output_root, stamp, username, records)
        print(f"[OK] {username}: OCR backfill from {latest.name} -> {len(records)} records -> {username}_event_sections_{stamp}.json")
        if merge_events:
            compare_rows.append(merge_instagram_for_username(username, records))
            cr = compare_rows[-1]
            print(
                f"     merged events: candidates={cr['instagram_candidates']} "
                f"new_unique={cr['instagram_new_unique']} total={cr['existing_after_merge']}"
            )
    if merge_events and compare_rows:
        write_compare_report(f"{stamp}_ocr_backfill", compare_rows)


def write_compare_report(stamp: str, compare_rows: List[Dict[str, object]]) -> None:
    ensure_dir(REPORTS_DIR)
    md_lines = ["# Instagram Tandem Compare Report", "", f"Generated: {stamp}", ""]
    for row in compare_rows:
        md_lines.append(f"## {row['source'].upper()}")
        md_lines.append(f"- Existing rows before merge: **{row['existing_before']}**")
        md_lines.append(f"- Instagram candidate rows: **{row['instagram_candidates']}**")
        md_lines.append(f"- New unique from Instagram: **{row['instagram_new_unique']}**")
        md_lines.append(f"- Rows after merge: **{row['existing_after_merge']}**")
        md_lines.append("")
    (REPORTS_DIR / f"instagram_tandem_compare_{stamp}.md").write_text("\n".join(md_lines), encoding="utf-8")
    save_json(REPORTS_DIR / f"instagram_tandem_compare_{stamp}.json", compare_rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape NJ masjid Instagram and merge with Safar datasets.")
    parser.add_argument("--usernames", nargs="+", default=DEFAULT_USERNAMES)
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--post-count", type=int, default=50)
    parser.add_argument("--output-dir", default=str(OUTPUT_ROOT))
    parser.add_argument("--no-ocr", action="store_true")
    parser.add_argument(
        "--atomic-scrape",
        action="store_true",
        help="Download posts first, OCR all posters for each account, then merge once (avoids caption-only vs OCR duplicates). Implies deferring merge until after OCR.",
    )
    parser.add_argument(
        "--ocr-backfill",
        action="store_true",
        help="Read latest *_event_sections_*.json per account, OCR poster images, write new stamp; use after --no-ocr scrape.",
    )
    parser.add_argument(
        "--no-merge-after-ocr",
        action="store_true",
        help="With --ocr-backfill, skip merging into events_by_masjid/*.json (only write new sections JSON).",
    )
    parser.add_argument(
        "--save-raw-api",
        action="store_true",
        help="Include sanitized Instagram API media item per post in sections JSON (large).",
    )
    parser.add_argument("--sleep-seconds", type=float, default=1.2, help="Throttle between IG pagination calls.")
    parser.add_argument(
        "--sessionid",
        default="",
        help="Instagram sessionid cookie value; if blank, IG_SESSIONID env var is used.",
    )
    parser.add_argument(
        "--csrftoken",
        default="",
        help="Instagram csrftoken cookie; if blank, IG_CSRFTOKEN env var is used.",
    )
    parser.add_argument(
        "--proxy",
        default="",
        help="HTTP/HTTPS/SOCKS proxy URL for Instagram only (e.g. http://127.0.0.1:8888). SOCKS may need PySocks.",
    )
    parser.add_argument(
        "--skip-recent-hours",
        type=float,
        default=float(os.environ.get("IG_SKIP_RECENT_HOURS", "0") or "0"),
        help="Skip accounts scraped successfully within N hours (friendly to IG; default 0=disabled).",
    )
    parser.add_argument(
        "--stop-on-block",
        action="store_true",
        default=os.environ.get("IG_STOP_ON_BLOCK", "").strip() == "1",
        help="If an account can't load even the HTML profile, stop the whole run (likely IP-blocked).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_root = Path(args.output_dir)
    ensure_dir(output_root)

    if args.ocr_backfill:
        run_ocr_backfill(
            list(args.usernames),
            output_root,
            merge_events=not args.no_merge_after_ocr,
        )
        return

    stamp = now_stamp()
    session = requests.Session()
    session.headers.update(HEADERS)
    proxy_url = normalize_proxy_line(args.proxy) or normalize_proxy_line(
        os.environ.get("IG_HTTPS_PROXY", "") or os.environ.get("HTTPS_PROXY", "")
    )
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
        tail = proxy_url.split("@", 1)[-1] if "@" in proxy_url else proxy_url
        print(f"[INFO] Using proxy for Instagram: {tail}")
    sessionid = clean_spaces(args.sessionid) or clean_spaces(str(os.environ.get("IG_SESSIONID", "")))
    if sessionid:
        session.cookies.set("sessionid", sessionid, domain=".instagram.com")
    csrftoken = clean_spaces(args.csrftoken) or clean_spaces(str(os.environ.get("IG_CSRFTOKEN", "")))
    if csrftoken:
        session.cookies.set("csrftoken", csrftoken, domain=".instagram.com")
        session.headers["x-csrftoken"] = csrftoken

    warm_session(session)
    account_state = _load_account_state()
    consecutive_blocks = 0

    compare_rows: List[Dict[str, object]] = []
    combined_records: List[EventRecord] = []
    print(f"Starting Instagram scrape for {len(args.usernames)} accounts", flush=True)

    # Extra between-account pause to avoid tripping IG rate limits when proxies or
    # the runner IP get flagged. Tunable via IG_ACCOUNT_SLEEP_SECONDS.
    try:
        account_pause_s = max(0.0, float(os.environ.get("IG_ACCOUNT_SLEEP_SECONDS", "0")))
    except ValueError:
        account_pause_s = 0.0

    for acct_idx, username in enumerate(args.usernames):
        if acct_idx > 0 and account_pause_s > 0:
            print(
                f"[INFO] inter-account pause {account_pause_s:.1f}s before {username}",
                flush=True,
            )
            time.sleep(account_pause_s)
        if username not in SOURCE_MAP:
            print(f"[WARN] {username}: not mapped in SOURCE_MAP, skipping")
            continue
        if _recently_scraped(account_state, username, float(args.skip_recent_hours)):
            last_note = (account_state.get(username) or {}).get("last_note", "")
            print(f"[SKIP] {username}: scraped within {args.skip_recent_hours}h ({last_note})")
            continue
        source_meta = SOURCE_MAP[username]
        source = source_meta["source"]
        print(f"\n[INFO] Scraping {username} -> source={source}")
        if args.atomic_scrape:
            records = scrape_account(
                session=session,
                username=username,
                days=max(1, args.days),
                post_count=max(10, min(50, args.post_count)),
                output_root=output_root,
                do_ocr=False,
                sleep_seconds=max(0.0, args.sleep_seconds),
                save_raw_api=bool(args.save_raw_api),
            )
            ocr_dir = output_root / username / "ocr"
            records = apply_ocr_to_event_records(records, ocr_dir)
            print(f"[INFO] {username}: atomic scrape — OCR applied locally before merge ({len(records)} records)")
        else:
            records = scrape_account(
                session=session,
                username=username,
                days=max(1, args.days),
                post_count=max(10, min(50, args.post_count)),
                output_root=output_root,
                do_ocr=not args.no_ocr,
                sleep_seconds=max(0.0, args.sleep_seconds),
                save_raw_api=bool(args.save_raw_api),
            )
        write_account_outputs(output_root, stamp, username, records)
        combined_records.extend(records)

        cr = merge_instagram_for_username(username, records)
        compare_rows.append(cr)
        print(
            f"[OK] {username}: candidates={cr['instagram_candidates']} "
            f"new_unique={cr['instagram_new_unique']} merged_total={cr['existing_after_merge']}"
        )

        if not records:
            consecutive_blocks += 1
            _mark_account_result(account_state, username, success=False, count=0, note="no_records")
            if args.stop_on_block and consecutive_blocks >= 3:
                print("[STOP] 3 consecutive accounts returned no records — likely IP-blocked; stopping.")
                _save_account_state(account_state)
                break
        else:
            consecutive_blocks = 0
            _mark_account_result(
                account_state, username, success=True, count=len(records), note="records_fetched"
            )
        _save_account_state(account_state)

    # Combined archive payload
    ensure_dir(output_root / "combined")
    save_json(
        output_root / "combined" / f"nj_masjid_events_combined_{stamp}.json",
        {
            "usernames": args.usernames,
            "total_events": len(combined_records),
            "events": [asdict(x) for x in combined_records],
        },
    )
    write_compare_report(stamp, compare_rows)
    print(f"\nDone. Combined records={len(combined_records)} stamp={stamp}")
    print(f"Events dir updated: {EVENTS_DIR}")


if __name__ == "__main__":
    main()

