#!/usr/bin/env python3
# Requirements: pip install requests beautifulsoup4 lxml
#
# Usage: .venv/bin/python refresh_mcnj_events.py
# Output: events_by_masjid/mcnj_events.json
#
# MCNJ lists Jumu'ah times in the homepage markup; programmatic event cards are mostly client-side.
# We emit weekly first + second Jumu'ah rows from the published khutbah / iqamah times.

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
OUT_JSON = OUT_DIR / "mcnj_events.json"
HOME = "https://mcnjonline.com/"
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


def _norm_time(s: str) -> str:
    t = clean(s)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"(?i)(\d{1,2}:\d{2})(pm|am)\b", r"\1 \2", t)
    if re.search(r"\d{1,2}:\d{2}\s*$", t) and not re.search(r"(?i)am|pm", t):
        t = f"{t} PM"
    return t


def parse_jumuah_times(html: str) -> Tuple[str, str, str, str]:
    """
    Returns (first_khutbah, first_iqamah, second_khutbah, second_iqamah) as displayed strings.
    """
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=True)
    first_k, first_i, second_k, second_i = "1:15 PM", "1:35 PM", "2:10 PM", "2:30 PM"
    m = re.search(
        r"Jumah\s+1st[\s\S]{0,200}?Khutbah\s*:\s*([^<\n]+)[\s\S]{0,120}?Iqamah\s*:\s*([^<\n]+)",
        text,
        re.I,
    )
    if m:
        first_k, first_i = _norm_time(m.group(1)), _norm_time(m.group(2))
    m2 = re.search(
        r"Jumah\s+2nd[\s\S]{0,200}?Khutbah\s*:\s*([^<\n]+)[\s\S]{0,120}?Iqamah\s*:\s*([^<\n]+)",
        text,
        re.I,
    )
    if m2:
        second_k, second_i = _norm_time(m2.group(1)), _norm_time(m2.group(2))
    return first_k, first_i, second_k, second_i


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
    fk, fi, sk, si = parse_jumuah_times(html)
    rows: List[Dict] = []
    for d in next_fridays(26):
        rows.append(
            {
                "source": "mcnj",
                "source_type": "website",
                "source_url": HOME,
                "title": "Jumu'ah — 1st khutbah",
                "description": f"First Jumu'ah at MCNJ Fords. Khutbah {fk}; iqamah {fi}.",
                "date": d.isoformat(),
                "start_time": fk,
                "end_time": fi,
                "location_name": "Muslim Community of New Jersey Masjid",
                "address": "15 S 2nd St, Fords, NJ 08863",
                "city": "Fords",
                "state": "NJ",
                "zip": "08863",
                "category": "jummah",
                "audience": "general",
                "organizer": "MCNJ",
                "rsvp_link": "",
                "image_urls": [],
                "raw_text": "Weekly Jumu'ah (1st) from mcnjonline.com published times.",
                "confidence": 0.8,
            }
        )
        rows.append(
            {
                "source": "mcnj",
                "source_type": "website",
                "source_url": HOME,
                "title": "Jumu'ah — 2nd khutbah",
                "description": f"Second Jumu'ah at MCNJ Fords. Khutbah {sk}; iqamah {si}.",
                "date": d.isoformat(),
                "start_time": sk,
                "end_time": si,
                "location_name": "Muslim Community of New Jersey Masjid",
                "address": "15 S 2nd St, Fords, NJ 08863",
                "city": "Fords",
                "state": "NJ",
                "zip": "08863",
                "category": "jummah",
                "audience": "general",
                "organizer": "MCNJ",
                "rsvp_link": "",
                "image_urls": [],
                "raw_text": "Weekly Jumu'ah (2nd) from mcnjonline.com published times.",
                "confidence": 0.8,
            }
        )
    OUT_JSON.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"saved={OUT_JSON} rows={len(rows)} times=({fk!r},{fi!r}) ({sk!r},{si!r})")


if __name__ == "__main__":
    main()
