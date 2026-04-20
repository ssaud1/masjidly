#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml
#
# Usage:
#   .venv/bin/python refresh_nbic_events.py
#
# Output:
#   events_by_masjid/nbic_events.json
#
# Notes:
# - Pulls explicit dated events from NBIC pages when available
# - Expands recurring "regular programming" rules into dated events

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://www.nbic.org/"
PAGES = [
    "https://www.nbic.org/",
    "https://www.nbic.org/programs",
    "https://www.nbic.org/programs/ongoing",
    "https://www.nbic.org/future",
]
OUT_DIR = Path("/Users/shaheersaud/Safar/events_by_masjid")
OUT_JSON = OUT_DIR / "nbic_events.json"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def fetch_text(url: str, timeout: int = 20) -> Optional[str]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code == 200 and "text/html" in (r.headers.get("Content-Type", "").lower()):
            return r.text
    except requests.RequestException:
        return None
    return None


def base_event(
    *,
    source_url: str,
    title: str,
    description: str,
    date_iso: str,
    start_time: str = "",
    end_time: str = "",
    category: str = "",
    audience: str = "",
) -> Dict:
    return {
        "source": "nbic",
        "source_type": "website",
        "source_url": source_url,
        "title": clean(title),
        "description": clean(description),
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_time,
        "location_name": "New Brunswick Islamic Center",
        "address": "1330 Livingston Avenue, Unit #4, North Brunswick, NJ 08902",
        "city": "North Brunswick",
        "state": "NJ",
        "zip": "08902",
        "category": category,
        "audience": audience,
        "organizer": "NBIC",
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": clean(description)[:1200],
        "confidence": 0.9,
    }


def parse_possible_date(text: str, default_year: int) -> Optional[date]:
    txt = clean(text)
    # 3/29 or 03/29
    m = re.search(r"\b(\d{1,2})/(\d{1,2})\b", txt)
    if m:
        mm = int(m.group(1))
        dd = int(m.group(2))
        try:
            return date(default_year, mm, dd)
        except ValueError:
            return None
    # Mon, Mar 16th
    m2 = re.search(r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\,?\s*([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b", txt)
    if m2:
        mon = m2.group(1)
        dd = int(m2.group(2))
        for fmt in ("%b %d %Y", "%B %d %Y"):
            try:
                return datetime.strptime(f"{mon} {dd} {default_year}", fmt).date()
            except ValueError:
                continue
    return None


def parse_explicit_upcoming_events() -> List[Dict]:
    out: List[Dict] = []
    now = datetime.now().date()
    html = fetch_text(BASE)
    if not html:
        return out
    soup = BeautifulSoup(html, "lxml")

    # Pull likely "Upcoming Events" cards from heading blocks.
    candidates = []
    for tag in soup.find_all(["h1", "h2", "h3", "h4"]):
        t = clean(tag.get_text(" ", strip=True))
        if not t:
            continue
        if any(k in t.lower() for k in ("upcoming events", "regular programming", "ramadan programming")):
            parent = tag.parent
            if parent:
                candidates.append(parent)

    blocks = candidates if candidates else [soup]
    for block in blocks:
        text = clean(block.get_text(" ", strip=True))
        # Event title lines often contain short names; take heading tags in block.
        for h in block.find_all(["h2", "h3", "h4", "strong"]):
            title = clean(h.get_text(" ", strip=True))
            if not title or len(title) < 4:
                continue
            if title.lower() in {"upcoming events", "regular programming", "ramadan programming"}:
                continue
            if len(title.split()) > 14:
                continue
            around = clean(" ".join(s.get_text(" ", strip=True) for s in h.find_all_next(limit=6)))
            parsed = parse_possible_date(around, now.year)
            if not parsed:
                continue
            # If this year's parsed date is far in past, consider next year.
            if parsed < now - timedelta(days=120):
                try:
                    parsed = date(now.year + 1, parsed.month, parsed.day)
                except ValueError:
                    pass
            out.append(
                base_event(
                    source_url=BASE,
                    title=title,
                    description=around[:300],
                    date_iso=parsed.isoformat(),
                    category="community",
                )
            )
    return out


def first_weekday_of_month(year: int, month: int, weekday: int) -> date:
    d = date(year, month, 1)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d


def nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> date:
    d = first_weekday_of_month(year, month, weekday)
    d += timedelta(days=7 * (n - 1))
    return d


def last_weekday_of_month(year: int, month: int, weekday: int) -> date:
    if month == 12:
        d = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        d = date(year, month + 1, 1) - timedelta(days=1)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def recurring_regular_programming(months_ahead: int = 10) -> List[Dict]:
    out: List[Dict] = []
    today = datetime.now().date()
    month_cursor = date(today.year, today.month, 1)
    month_list: List[date] = []
    for _ in range(months_ahead + 1):
        month_list.append(month_cursor)
        if month_cursor.month == 12:
            month_cursor = date(month_cursor.year + 1, 1, 1)
        else:
            month_cursor = date(month_cursor.year, month_cursor.month + 1, 1)

    for m in month_list:
        y, mo = m.year, m.month

        # Family Night: last Friday of every month.
        family_day = last_weekday_of_month(y, mo, 4)  # Friday
        if family_day >= today:
            out.append(
                base_event(
                    source_url=urljoin(BASE, "programs/ongoing"),
                    title="Family Night",
                    description="Monthly social program for families to learn, connect, and share a meal.",
                    date_iso=family_day.isoformat(),
                    start_time="19:30",
                    end_time="21:00",
                    category="family",
                    audience="family",
                )
            )

        # Ladies Night: first Wednesday of every month.
        ladies_day = first_weekday_of_month(y, mo, 2)  # Wednesday
        if ladies_day >= today:
            out.append(
                base_event(
                    source_url=urljoin(BASE, "programs/ongoing"),
                    title="Ladies Night",
                    description="Ladies-only evening with Dr. Tammy Elmansoury, Companion's Series.",
                    date_iso=ladies_day.isoformat(),
                    start_time="19:30",
                    end_time="21:00",
                    category="sisters",
                    audience="sisters",
                )
            )

        # Dhikr Night: first and third Friday (after Isha approximation).
        first_friday = first_weekday_of_month(y, mo, 4)
        third_friday = nth_weekday_of_month(y, mo, 4, 3)
        for d in (first_friday, third_friday):
            if d >= today:
                out.append(
                    base_event(
                        source_url=urljoin(BASE, "programs/ongoing"),
                        title="Dhikr Night",
                        description="First and third Friday after Isha prayer.",
                        date_iso=d.isoformat(),
                        start_time="20:30",
                        end_time="22:00",
                        category="dhikr",
                        audience="everyone",
                    )
                )

        # Thursday Dhikr / mini Mawlid: every Thursday.
        first_thu = first_weekday_of_month(y, mo, 3)  # Thursday
        d = first_thu
        while d.month == mo:
            if d >= today:
                out.append(
                    base_event(
                        source_url=urljoin(BASE, "programs/ongoing"),
                        title="Thursday Dhikr & Mini Mawlid",
                        description="Weekly remembrance gathering every Thursday.",
                        date_iso=d.isoformat(),
                        start_time="20:00",
                        end_time="21:00",
                        category="dhikr",
                        audience="everyone",
                    )
                )
            d += timedelta(days=7)
    return out


def dedupe(events: List[Dict]) -> List[Dict]:
    out: List[Dict] = []
    seen = set()
    for e in events:
        key = (
            clean(e.get("title", "")).lower(),
            clean(e.get("date", "")),
            clean(e.get("start_time", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date", "9999-12-31"), x.get("start_time", "99:99"), x.get("title", "")))
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    explicit = parse_explicit_upcoming_events()
    recurring = recurring_regular_programming(months_ahead=12)
    merged = dedupe(explicit + recurring)
    OUT_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"explicit={len(explicit)} recurring={len(recurring)} total={len(merged)}")
    print(f"saved={OUT_JSON}")


if __name__ == "__main__":
    main()
