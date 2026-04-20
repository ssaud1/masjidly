#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml dateparser
#
# Usage:
#   .venv/bin/python refresh_iceb_mcmc.py
#
# Output:
#   events_by_masjid/iceb_events.json
#   events_by_masjid/mcmc_events.json

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import urljoin, urlparse

import dateparser
import requests
from bs4 import BeautifulSoup

OUT_DIR = Path("/Users/shaheersaud/Safar/events_by_masjid")
ICEB_OUT = OUT_DIR / "iceb_events.json"
MCMC_OUT = OUT_DIR / "mcmc_events.json"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def fetch(url: str, timeout: int = 10) -> Optional[str]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code == 200 and "text/html" in (r.headers.get("Content-Type", "").lower()):
            return r.text
    except requests.RequestException:
        return None
    return None


def parse_date_time_from_text(text: str) -> (str, str, str):
    d = ""
    start = ""
    end = ""
    for rx in (
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*20\d{2})?\b",
        r"\b\d{1,2}/\d{1,2}/20\d{2}\b",
    ):
        m = re.search(rx, text, flags=re.I)
        if m:
            p = dateparser.parse(m.group(0), settings={"PREFER_DATES_FROM": "future"})
            if p:
                d = p.date().isoformat()
                break
    m2 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\s*[-–]\s*(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, flags=re.I)
    if m2:
        start, end = m2.group(1), m2.group(2)
    else:
        m3 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, flags=re.I)
        if m3:
            start = m3.group(1)
    return d, start, end


def collect_images(soup: BeautifulSoup, base_url: str) -> List[str]:
    urls = []
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src")
        if not src:
            continue
        full = urljoin(base_url, src)
        low = full.lower()
        if any(x in low for x in ("logo", "icon", "favicon", "avatar")):
            continue
        if full not in urls:
            urls.append(full)
        if len(urls) >= 6:
            break
    return urls


def parse_event_page(url: str, source: str, organizer: str, location_name: str, address: str, city: str, state: str, zip_code: str) -> Optional[Dict]:
    html = fetch(url)
    if not html:
        return None
    soup = BeautifulSoup(html, "lxml")
    title = ""
    h1 = soup.find("h1")
    if h1:
        title = clean(h1.get_text(" ", strip=True))
    if not title and soup.title:
        title = clean(soup.title.get_text(" ", strip=True).split("|")[0])
    if not title:
        return None
    text = clean(soup.get_text(" ", strip=True))
    desc = ""
    for p in soup.find_all("p"):
        t = clean(p.get_text(" ", strip=True))
        if 70 <= len(t) <= 900:
            desc = t
            break
    d, st, en = parse_date_time_from_text(text)
    if not d:
        m = re.search(r"(20\d{2}-\d{2}-\d{2})", url)
        if m:
            d = m.group(1)
    return {
        "source": source,
        "source_type": "website",
        "source_url": url,
        "title": title,
        "description": desc,
        "date": d,
        "start_time": st,
        "end_time": en,
        "location_name": location_name,
        "address": address,
        "city": city,
        "state": state,
        "zip": zip_code,
        "category": "",
        "audience": "",
        "organizer": organizer,
        "rsvp_link": "",
        "image_urls": collect_images(soup, url),
        "raw_text": text[:1400],
        "confidence": 0.7 if d else 0.55,
        "speaker": "",
    }


def discover_links(base_url: str, seeds: List[str], keywords: List[str], max_links: int = 120) -> List[str]:
    host = (urlparse(base_url).hostname or "").lower()
    links: Set[str] = set()
    for seed in seeds:
        html = fetch(seed)
        if not html:
            continue
        soup = BeautifulSoup(html, "lxml")
        for a in soup.find_all("a", href=True):
            href = clean(a["href"])
            if not href:
                continue
            full = urljoin(seed, href)
            if (urlparse(full).hostname or "").lower() != host:
                continue
            low = full.lower()
            if any(k in low for k in keywords):
                links.add(full.rstrip("/"))
    out = sorted(links)
    return out[:max_links]


def dedupe(events: List[Dict]) -> List[Dict]:
    seen = set()
    out = []
    for e in events:
        key = (clean(e.get("title", "")).lower(), clean(e.get("date", "")), clean(e.get("source_url", "")).lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("title") or ""))
    return out


def is_iceb_event_detail_url(url: str) -> bool:
    parsed = urlparse(url)
    path = (parsed.path or "").rstrip("/")
    if not path.startswith("/events"):
        return False
    # Reject listing/pagination/anchor pages that cause generic or stale entries.
    if path in ("/events", "/event-request"):
        return False
    if parsed.fragment:
        return False
    q = (parsed.query or "").lower()
    if "pno=" in q or "page=" in q:
        return False
    slug = path.split("/events/", 1)[-1].strip("/")
    if not slug:
        return False
    blocked = ("upcoming-events", "event-request")
    if any(b in slug for b in blocked):
        return False
    return True


def build_iceb_friday_recurring_events(weeks: int = 16) -> List[Dict]:
    """
    Add known recurring ICEB Friday youth programs supplied by user.
    - Future Leaders of Islam Youth every Friday:
      this Friday = Bowling, next Friday = Muslim Heroes, then generic series title.
    - YM Sisters every Friday.
    """
    today = datetime.now().date()
    first_friday = today + timedelta(days=(4 - today.weekday()) % 7)  # Monday=0 ... Friday=4
    if weeks < 1:
        weeks = 1

    # Keep recurring entries local-only; avoid attaching generic listing page metadata/posters.
    series_url = ""
    base_fields = {
        "source": "iceb",
        "source_type": "website",
        "source_url": series_url,
        "location_name": "Islamic Center of East Brunswick",
        "address": "402 New Brunswick Ave, East Brunswick, NJ 08816",
        "city": "East Brunswick",
        "state": "NJ",
        "zip": "08816",
        "organizer": "Islamic Center of East Brunswick",
        "rsvp_link": "",
        "image_urls": [],
        "speaker": "",
        "start_time": "",
        "end_time": "",
    }

    out: List[Dict] = []
    for i in range(weeks):
        d = (first_friday + timedelta(days=i * 7)).isoformat()

        if i == 0:
            youth_title = "Future Leaders of Islam Youth - Bowling"
        elif i == 1:
            youth_title = "Future Leaders of Islam Youth - Muslim Heroes"
        else:
            youth_title = "Future Leaders of Islam Youth"

        out.append(
            {
                **base_fields,
                "title": youth_title,
                "description": (
                    "ICEB Friday youth program series. This Friday is Bowling, next Friday is Muslim Heroes, "
                    "then the Future Leaders of Islam Youth series continues weekly."
                ),
                "date": d,
                "start_time": "After Maghrib",
                "category": "youth",
                "audience": "youth",
                "raw_text": "Future Leaders of Islam Youth every Friday at ICEB.",
                "confidence": 0.66,
            }
        )

        out.append(
            {
                **base_fields,
                "title": "YM Sisters (Friday Program)",
                "description": "Weekly Friday YM Sisters program at ICEB.",
                "date": d,
                "start_time": "After Isha",
                "category": "sisters",
                "audience": "sisters",
                "raw_text": "YM Sisters every Friday at ICEB.",
                "confidence": 0.66,
            }
        )

    return out


def sanitize_iceb_events(events: List[Dict]) -> List[Dict]:
    out: List[Dict] = []
    for e in events:
        title = clean(str(e.get("title", ""))).lower()
        source_url = clean(str(e.get("source_url", ""))).lower()
        # Drop generic listing/request pages that produce noisy descriptions/posters.
        if title.startswith("upcoming events"):
            continue
        if "event request" in title:
            continue
        if source_url.endswith("/events") or source_url.endswith("/events/") or "/events/#" in source_url:
            continue
        if "event-request" in source_url:
            continue
        if "/events/?pno=" in source_url or "/events?pno=" in source_url:
            continue
        out.append(e)
    return out


def build_iceb() -> List[Dict]:
    base = "https://www.icebnj.net/"
    seeds = [
        base,
        "https://www.icebnj.net/events/",
    ]
    links = discover_links(base, seeds, ["/events/", "event"], max_links=40)
    links = [u for u in links if is_iceb_event_detail_url(u)]
    events = []
    for i, u in enumerate(links, 1):
        ev = parse_event_page(
            u,
            "iceb",
            "Islamic Center of East Brunswick",
            "Islamic Center of East Brunswick",
            "402 New Brunswick Ave, East Brunswick, NJ 08816",
            "East Brunswick",
            "NJ",
            "08816",
        )
        if ev:
            t = clean(str(ev.get("title", ""))).lower()
            if t.startswith("upcoming events") or "event request" in t:
                continue
            events.append(ev)
        if i % 5 == 0:
            print(f"iceb_parsed={i}/{len(links)}")
    return dedupe(sanitize_iceb_events(events))


def build_mcmc() -> List[Dict]:
    base = "https://www.mcmcnj.org/"
    seeds = [
        base,
        "https://www.mcmcnj.org/events/",
        "https://www.mcmcnj.org/calendar/",
    ]
    links = discover_links(base, seeds, ["/event", "/events", "/calendar", "program"], max_links=20)
    events = []
    for i, u in enumerate(links, 1):
        ev = parse_event_page(
            u,
            "mcmc",
            "Muslim Center of Middlesex County",
            "Muslim Center of Middlesex County",
            "1000 Hoes Ln, Piscataway, NJ 08854",
            "Piscataway",
            "NJ",
            "08854",
        )
        if ev:
            events.append(ev)
        if i % 5 == 0:
            print(f"mcmc_parsed={i}/{len(links)}")
    return dedupe(events)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    existing_iceb = []
    existing_mcmc = []
    if ICEB_OUT.exists():
        try:
            existing_iceb = json.loads(ICEB_OUT.read_text(encoding="utf-8"))
        except Exception:
            existing_iceb = []
    if MCMC_OUT.exists():
        try:
            existing_mcmc = json.loads(MCMC_OUT.read_text(encoding="utf-8"))
        except Exception:
            existing_mcmc = []

    iceb = build_iceb()
    mcmc = build_mcmc()
    if not iceb and existing_iceb:
        print(f"iceb scrape returned 0, keeping existing={len(existing_iceb)}")
        iceb = existing_iceb
    if not mcmc and existing_mcmc:
        print(f"mcmc scrape returned 0, keeping existing={len(existing_mcmc)}")
        mcmc = existing_mcmc
    ICEB_OUT.write_text(json.dumps(iceb, indent=2, ensure_ascii=False), encoding="utf-8")
    MCMC_OUT.write_text(json.dumps(mcmc, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"iceb={len(iceb)} -> {ICEB_OUT}")
    print(f"mcmc={len(mcmc)} -> {MCMC_OUT}")


if __name__ == "__main__":
    main()
