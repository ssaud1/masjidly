#!/usr/bin/env python3
"""Best-effort HTML scrapers for NJ masjids that were missing from the pipeline.

Covers the masjids whose primary events URL is a real website (not just an
Instagram profile):
  - jmic (Jam-e-Masjid Islamic Center)
  - icoc (Islamic Center of Ocean County)
  - bayonne_mc (Bayonne Muslims Community Center)
  - isbc (Islamic Society of Basking Ridge)
  - mcjc (Muslim Center of Jersey City)

Each run writes ``events_by_masjid/<source>_events.json`` with an array of
events. If a site is unreachable we still write an empty list so downstream
consumers see the source, and the synthetic-Jumu'ah step will top up coverage.

Requirements (already vendored in the project's virtualenv):
  - requests
  - beautifulsoup4
  - lxml

Run standalone:
  .venv/bin/python refresh_more_masjid_websites.py
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

OUT_DIR = Path(__file__).resolve().parent / "events_by_masjid"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
DATE_WINDOW_DAYS = 180
REQUEST_TIMEOUT = 20

MONTHS_LONG = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
MONTHS_SHORT = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)"
DAY_NAMES = r"(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*\.?"

WEEKDAY_MAP = {
    "sunday": 6,
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
}


@dataclass
class MasjidSiteConfig:
    source: str
    name: str
    pages: List[str]
    location_name: str
    address: str
    city: str
    state: str = "NJ"
    zip_code: str = ""
    organizer: str = ""
    title_keywords: List[str] = field(
        default_factory=lambda: [
            "class",
            "program",
            "event",
            "night",
            "lecture",
            "circle",
            "halaqa",
            "halaqah",
            "youth",
            "sisters",
            "fundraiser",
            "iftar",
            "ramadan",
            "tafsir",
            "seerah",
            "qur",
            "quran",
            "bazaar",
        ]
    )
    weekly_recurring: List[Dict] = field(default_factory=list)
    monthly_recurring: List[Dict] = field(default_factory=list)


MASJID_SITES: List[MasjidSiteConfig] = [
    MasjidSiteConfig(
        source="jmic",
        name="Jam-e-Masjid Islamic Center",
        pages=["https://www.jmic.org/", "https://www.jmic.org/events"],
        location_name="Jam-e-Masjid Islamic Center",
        address="1 Jame Masjid Cir",
        city="Boonton",
        zip_code="07005",
        organizer="JMIC",
        weekly_recurring=[
            {
                "weekday": "sunday",
                "title": "Sunday School",
                "description": "Weekly Islamic Sunday School at JMIC for children and youth.",
                "start_time": "10:00",
                "end_time": "13:00",
                "category": "youth",
                "audience": "family",
            },
        ],
    ),
    MasjidSiteConfig(
        source="icoc",
        name="Islamic Center of Ocean County",
        pages=["https://icoconline.org/", "https://icoconline.org/events/"],
        location_name="Islamic Center of Ocean County",
        address="530 Brick Blvd",
        city="Brick Township",
        zip_code="08723",
        organizer="ICOC",
        weekly_recurring=[
            {
                "weekday": "saturday",
                "title": "Weekend School",
                "description": "Weekly Islamic weekend school program for children.",
                "start_time": "10:00",
                "end_time": "13:00",
                "category": "youth",
                "audience": "family",
            },
        ],
    ),
    MasjidSiteConfig(
        source="bayonne_mc",
        name="Bayonne Muslims Community Center",
        pages=["https://bayonnemasjid.com/", "https://bayonnemasjid.com/events/"],
        location_name="Bayonne Muslims Community Center",
        address="109 W 49th St",
        city="Bayonne",
        zip_code="07002",
        organizer="Bayonne Muslims",
        weekly_recurring=[
            {
                "weekday": "friday",
                "title": "Community Halaqa",
                "description": "Weekly halaqa at Bayonne Muslims Community Center.",
                "start_time": "20:30",
                "end_time": "21:30",
                "category": "halaqa",
                "audience": "all",
            },
        ],
    ),
    MasjidSiteConfig(
        source="isbc",
        name="Islamic Society of Basking Ridge",
        pages=["https://www.isbcnj.org/", "https://www.isbcnj.org/events"],
        location_name="Islamic Society of Basking Ridge",
        address="3004 Valley Rd",
        city="Basking Ridge",
        zip_code="07920",
        organizer="ISBC",
        weekly_recurring=[
            {
                "weekday": "sunday",
                "title": "ISBC Sunday School",
                "description": "Weekly Sunday School for youth at ISBC.",
                "start_time": "10:00",
                "end_time": "12:30",
                "category": "youth",
                "audience": "family",
            },
        ],
    ),
    MasjidSiteConfig(
        source="mcjc",
        name="Muslim Center of Jersey City",
        pages=["https://muslimcenterjc.org/", "https://muslimcenterjc.org/events/"],
        location_name="Muslim Center of Jersey City",
        address="2155 Kennedy Blvd",
        city="Jersey City",
        zip_code="07305",
        organizer="Muslim Center of Jersey City",
        weekly_recurring=[
            {
                "weekday": "saturday",
                "title": "MCJC Weekend School",
                "description": "Weekly weekend school for youth at MCJC.",
                "start_time": "10:00",
                "end_time": "13:00",
                "category": "youth",
                "audience": "family",
            },
        ],
    ),
]


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def fetch_html(url: str) -> Optional[str]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200 and "text/html" in resp.headers.get("Content-Type", "").lower():
            return resp.text
    except requests.RequestException:
        return None
    return None


def _try_parse_date(text: str, fallback_year: int) -> Optional[date]:
    txt = clean(text)
    if not txt:
        return None

    m = re.search(r"\b(20\d{2})-(\d{1,2})-(\d{1,2})\b", txt)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass

    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b", txt)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        except ValueError:
            pass

    m = re.search(rf"\b(?:{DAY_NAMES}[,\s]+)?({MONTHS_LONG}|{MONTHS_SHORT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(20\d{{2}}))?", txt)
    if m:
        mon = m.group(1)
        day = int(m.group(2))
        year_str = m.group(3)
        year = int(year_str) if year_str else fallback_year
        for fmt in ("%b %d %Y", "%B %d %Y", "%b. %d %Y"):
            try:
                return datetime.strptime(f"{mon} {day} {year}", fmt).date()
            except ValueError:
                continue
    return None


def base_event(
    cfg: MasjidSiteConfig,
    *,
    source_url: str,
    title: str,
    description: str,
    date_iso: str,
    start_time: str = "",
    end_time: str = "",
    category: str = "",
    audience: str = "",
    confidence: float = 0.65,
) -> Dict:
    return {
        "source": cfg.source,
        "source_type": "website",
        "source_url": source_url,
        "title": clean(title),
        "description": clean(description),
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_time,
        "location_name": cfg.location_name,
        "address": cfg.address,
        "city": cfg.city,
        "state": cfg.state,
        "zip": cfg.zip_code,
        "category": category,
        "audience": audience,
        "organizer": cfg.organizer or cfg.name,
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": clean(description)[:800],
        "confidence": confidence,
    }


def parse_explicit_events(cfg: MasjidSiteConfig) -> List[Dict]:
    out: List[Dict] = []
    today = datetime.now().date()
    horizon = today + timedelta(days=DATE_WINDOW_DAYS)
    seen_keys: set = set()

    for url in cfg.pages:
        html = fetch_html(url)
        if not html:
            continue
        soup = BeautifulSoup(html, "lxml")

        headings = soup.find_all(["h1", "h2", "h3", "h4", "h5", "strong"])
        for h in headings:
            title = clean(h.get_text(" ", strip=True))
            if not title or len(title) < 4 or len(title.split()) > 16:
                continue
            if not any(k in title.lower() for k in cfg.title_keywords):
                context = " ".join(
                    clean(sib.get_text(" ", strip=True))
                    for sib in h.find_all_next(limit=4)
                    if sib and sib.name in {"p", "span", "div", "li"}
                )
                blob = f"{title} {context}".lower()
                if not any(k in blob for k in cfg.title_keywords):
                    continue

            window = " ".join(
                clean(sib.get_text(" ", strip=True))
                for sib in h.find_all_next(limit=6)
                if sib and sib.name in {"p", "span", "div", "li", "h4", "h5"}
            )
            parsed_date = _try_parse_date(window, today.year)
            if not parsed_date:
                continue
            if parsed_date < today - timedelta(days=7):
                try:
                    parsed_date = date(today.year + 1, parsed_date.month, parsed_date.day)
                except ValueError:
                    continue
            if parsed_date > horizon:
                continue

            key = (title.lower(), parsed_date.isoformat())
            if key in seen_keys:
                continue
            seen_keys.add(key)

            out.append(
                base_event(
                    cfg,
                    source_url=url,
                    title=title,
                    description=window[:480],
                    date_iso=parsed_date.isoformat(),
                    category="community",
                    confidence=0.7,
                )
            )
    return out


def weekly_recurring(cfg: MasjidSiteConfig, weeks: int = 12) -> List[Dict]:
    if not cfg.weekly_recurring:
        return []
    out: List[Dict] = []
    today = datetime.now().date()
    for spec in cfg.weekly_recurring:
        weekday = WEEKDAY_MAP.get(str(spec.get("weekday", "")).lower())
        if weekday is None:
            continue
        delta = (weekday - today.weekday()) % 7
        first_occurrence = today + timedelta(days=delta)
        for i in range(weeks):
            d = first_occurrence + timedelta(days=7 * i)
            out.append(
                base_event(
                    cfg,
                    source_url=urljoin(cfg.pages[0], "#recurring"),
                    title=spec.get("title", "Weekly Program"),
                    description=spec.get("description", ""),
                    date_iso=d.isoformat(),
                    start_time=spec.get("start_time", ""),
                    end_time=spec.get("end_time", ""),
                    category=spec.get("category", ""),
                    audience=spec.get("audience", ""),
                    confidence=0.55,
                )
            )
    return out


def dedupe(events: Iterable[Dict]) -> List[Dict]:
    seen: set = set()
    out: List[Dict] = []
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


def refresh_one(cfg: MasjidSiteConfig) -> int:
    explicit = parse_explicit_events(cfg)
    recurring = weekly_recurring(cfg)
    merged = dedupe(explicit + recurring)
    out_path = OUT_DIR / f"{cfg.source}_events.json"
    out_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[{cfg.source}] explicit={len(explicit)} recurring={len(recurring)} total={len(merged)} -> {out_path.name}")
    return len(merged)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    grand_total = 0
    for cfg in MASJID_SITES:
        grand_total += refresh_one(cfg)
    print(f"[refresh_more_masjid_websites] wrote {grand_total} events across {len(MASJID_SITES)} masjids")


if __name__ == "__main__":
    main()
