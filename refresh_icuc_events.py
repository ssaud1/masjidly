#!/usr/bin/env python3
# Requirements: pip install requests
#
# Usage: .venv/bin/python refresh_icuc_events.py
# Output: events_by_masjid/icuc_events.json
#
# ICUC (Squarespace) published "New Events" JSON; on-air upcoming is often empty.
# We emit (1) any Squarespace items with start dates in the future and
# (2) a recurring first-Saturday open house row (times from public outreach copy).

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List
from zoneinfo import ZoneInfo

import requests

ROOT = Path("/Users/shaheersaud/Safar")
OUT_DIR = ROOT / "events_by_masjid"
OUT_JSON = OUT_DIR / "icuc_events.json"
BASE = "https://www.icucnj.com"
JSON_URL = f"{BASE}/new-events?format=json"
TZ = ZoneInfo("America/New_York")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def ms_to_local_date(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000.0, tz=TZ)
    return dt.date().isoformat()


def ms_to_local_hhmm(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000.0, tz=TZ)
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"


def base_event(**kwargs) -> Dict:
    defaults: Dict = {
        "source": "icuc",
        "source_type": "website",
        "source_url": BASE + "/",
        "title": "",
        "description": "",
        "date": "",
        "start_time": "",
        "end_time": "",
        "location_name": "Islamic Center of Union County",
        "address": "2372 Morris Ave, Union, NJ 07083",
        "city": "Union",
        "state": "NJ",
        "zip": "07083",
        "category": "community",
        "audience": "general",
        "organizer": "Islamic Center of Union County",
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": "",
        "confidence": 0.82,
    }
    defaults.update(kwargs)
    return defaults


def squarespace_items() -> List[Dict]:
    try:
        r = requests.get(JSON_URL, headers=HEADERS, timeout=25)
        r.raise_for_status()
        payload = r.json()
    except Exception:
        return []
    out: List[Dict] = []
    today = date.today().isoformat()
    for bucket in ("upcoming", "past"):
        for item in payload.get(bucket) or []:
            if not isinstance(item, dict):
                continue
            title = clean(str(item.get("title", "")))
            if not title:
                continue
            start_ms = item.get("startDate")
            end_ms = item.get("endDate")
            if not isinstance(start_ms, (int, float)):
                continue
            ds = ms_to_local_date(int(start_ms))
            if ds < today:
                continue
            st = ms_to_local_hhmm(int(start_ms))
            en = ms_to_local_hhmm(int(end_ms)) if isinstance(end_ms, (int, float)) else ""
            path = clean(str(item.get("fullUrl", "")).lstrip("/"))
            url = f"{BASE}/{path}" if path else BASE + "/new-events"
            desc = ""
            body = item.get("body") or ""
            if isinstance(body, str) and body:
                desc = clean(re.sub(r"<[^>]+>", " ", body))[:500]
            out.append(
                base_event(
                    source_url=url,
                    title=title,
                    description=desc or f"{title} at ICUC.",
                    date=ds,
                    start_time=st,
                    end_time=en if en != st else "",
                    raw_text=desc[:1200],
                    confidence=0.88,
                )
            )
    return out


def first_saturday_open_houses(months: int = 14) -> List[Dict]:
    """First Saturday monthly community open house (publicized evening window)."""
    out: List[Dict] = []
    today = date.today()
    y, m = today.year, today.month
    for _ in range(months):
        d = date(y, m, 1)
        while d.weekday() != 5:  # Saturday
            d += timedelta(days=1)
        if d >= today:
            out.append(
                base_event(
                    source_url=f"{BASE}/outreach",
                    title="Monthly community open house",
                    description=(
                        "First Saturday of the month; open to the community. "
                        "Confirm exact time on icucnj.com or ICUC announcements."
                    ),
                    date=d.isoformat(),
                    start_time="07:00 PM",
                    end_time="09:00 PM",
                    category="open_house",
                    raw_text="Recurring first-Saturday open house coverage row.",
                    confidence=0.72,
                )
            )
        if m == 12:
            y += 1
            m = 1
        else:
            m += 1
    return out


def dedupe(rows: List[Dict]) -> List[Dict]:
    seen = set()
    out: List[Dict] = []
    for e in rows:
        key = (clean(str(e.get("title", ""))).lower(), clean(str(e.get("date", ""))), clean(str(e.get("start_time", ""))))
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or ""))
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = dedupe(squarespace_items() + first_saturday_open_houses())
    OUT_JSON.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"saved={OUT_JSON} total={len(rows)}")


if __name__ == "__main__":
    main()
