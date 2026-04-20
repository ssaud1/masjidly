#!/usr/bin/env python3
# Requirements: pip install requests beautifulsoup4 lxml
#
# Usage: .venv/bin/python refresh_ismc_events.py
# Output: events_by_masjid/ismc_events.json
#
# ISMC uses a third-party calendar widget whose API URL on-site is missing a client id.
# We scrape the public homepage for the published first Jumu'ah time and emit weekly rows.

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup

ROOT = Path("/Users/shaheersaud/Safar")
OUT_DIR = ROOT / "events_by_masjid"
OUT_JSON = OUT_DIR / "ismc_events.json"
HOME = "https://ismcnj.org/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def fetch_html(url: str) -> Optional[str]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=25)
        if r.status_code == 200 and "text/html" in (r.headers.get("Content-Type", "") or "").lower():
            return r.text
    except requests.RequestException:
        return None
    return None


def parse_jumuah_time(html: str) -> Tuple[str, str]:
    """Return (start_time, description_snippet) from prayer table."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=True)
    m = re.search(r"1ST\s+JUMU[^\n]*\n[^\d]*(\d{1,2}:\d{2}\s*(?:AM|PM))", text, re.I)
    if m:
        return clean(m.group(1)), "First Jumu'ah time from ismcnj.org prayer widget."
    m2 = re.search(r"JUMU[^\n]{0,40}\n[^\d]{0,40}(\d{1,2}:\d{2}\s*(?:AM|PM))", text, re.I)
    if m2:
        return clean(m2.group(1)), "Jumu'ah time from ismcnj.org homepage."
    return "01:00 PM", "Default first Jumu'ah slot; confirm on ismcnj.org."


def next_fridays(n: int) -> List[date]:
    today = date.today()
    d = today + timedelta(days=(4 - today.weekday()) % 7)
    out = []
    for _ in range(n):
        out.append(d)
        d += timedelta(days=7)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    html = fetch_html(HOME) or ""
    start_time, note = parse_jumuah_time(html)
    rows: List[Dict] = []
    for d in next_fridays(26):
        rows.append(
            {
                "source": "ismc",
                "source_type": "website",
                "source_url": HOME,
                "title": "Jumu'ah Prayer & Khutbah",
                "description": f"Weekly Jumu'ah at Masjid Al-Aman / ISMCNJ. {note}",
                "date": d.isoformat(),
                "start_time": start_time,
                "end_time": "",
                "location_name": "Islamic Society of Monmouth County (Masjid Al-Aman)",
                "address": "496 Red Hill Rd, Middletown, NJ 07748",
                "city": "Middletown",
                "state": "NJ",
                "zip": "07748",
                "category": "jummah",
                "audience": "general",
                "organizer": "ISMCNJ",
                "rsvp_link": "",
                "image_urls": [],
                "raw_text": note,
                "confidence": 0.78,
            }
        )
    OUT_JSON.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"saved={OUT_JSON} rows={len(rows)} jumuah_start={start_time!r}")


if __name__ == "__main__":
    main()
