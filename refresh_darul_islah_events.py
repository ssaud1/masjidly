#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml
#
# Usage:
#   .venv/bin/python refresh_darul_islah_events.py
#
# What it does:
# 1) Scrapes Darul Islah paginated event pages
# 2) Finds/downloads remote ICS feeds from the site
# 3) Parses local ICS file (if present)
# 4) Merges + dedupes all events into events_by_masjid/darul_islah_events.json

from __future__ import annotations

import json
import re
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://www.darulislah.org"
STARTS = [
    "https://www.darulislah.org/events/",
    "https://www.darulislah.org/events/list/",
    "https://www.darulislah.org/events/list/?eventDisplay=past",
]
LIVE_ICS_URLS = [
    "https://www.darulislah.org/events/list/?ical=1",
    "https://www.darulislah.org/events/list/?eventDisplay=past&ical=1",
]
LOCAL_ICS_GLOB = "darul-islah-muslim-society-of-bergen-county-*.ics"
OUT_DIR = Path("/Users/shaheersaud/Safar/events_by_masjid")
OUT_JSON = OUT_DIR / "darul_islah_events.json"
DOWNLOADED_ICS = OUT_DIR / "darul_islah_latest.ics"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.darulislah.org/",
}


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def fetch_text(url: str, timeout: int = 18, tries: int = 2) -> Optional[str]:
    for _ in range(tries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            if r.status_code == 200:
                return r.text
        except requests.RequestException:
            pass
    return None


def fetch_bytes(url: str, timeout: int = 18, tries: int = 2) -> Optional[bytes]:
    for _ in range(tries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            if r.status_code == 200:
                return r.content
        except requests.RequestException:
            pass
    return None


def is_event_detail(url: str) -> bool:
    p = urlparse(url).path.lower().rstrip("/")
    if not p.startswith("/events/"):
        return False
    if p in ("/events", "/events/list", "/events/month"):
        return False
    if "/page/" in p:
        return False
    if p.endswith("/ical"):
        return False
    if "ical=1" in url.lower():
        return False
    return len([x for x in p.split("/") if x]) >= 2


def discover_pages_and_links(max_pages: int = 40) -> Tuple[List[str], List[str], List[str]]:
    queue = deque(STARTS)
    seen_pages = set()
    event_links = set()
    ics_links = set()
    crawled_pages: List[str] = []

    while queue and len(crawled_pages) < max_pages:
        u = queue.popleft()
        if u in seen_pages:
            continue
        seen_pages.add(u)

        html = fetch_text(u)
        if not html:
            continue
        crawled_pages.append(u)
        soup = BeautifulSoup(html, "lxml")

        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            full = urljoin(u, href)
            if not full.startswith(BASE):
                continue
            low = full.lower()

            if is_event_detail(full):
                event_links.add(full.rstrip("/"))

            if ".ics" in low or "ical=1" in low or "outlook-ical" in low:
                ics_links.add(full)

            if ("/events/list/page/" in low or "eventdisplay=past" in low or "tribe-bar-date=" in low) and full not in seen_pages:
                queue.append(full)

    return crawled_pages, sorted(event_links), sorted(ics_links)


def parse_event_page(url: str) -> Optional[Dict]:
    html = fetch_text(url)
    if not html:
        return None
    soup = BeautifulSoup(html, "lxml")

    h1 = soup.find("h1")
    title = clean(h1.get_text(" ", strip=True)) if h1 else ""
    if not title and soup.title:
        title = clean(soup.title.get_text(" ", strip=True).split("|")[0])
    if not title:
        return None

    tl = title.lower()
    if any(x in tl for x in ("views navigation", "event views navigation", "quick links", "contact info", "related events", "events for")):
        return None

    text = clean(soup.get_text(" ", strip=True))
    date_iso = ""
    m = re.search(r"(20\d{2}-\d{2}-\d{2})", url)
    if m:
        date_iso = m.group(1)

    start_time = ""
    end_time = ""
    m2 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\s*[-–]\s*(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, re.I)
    if m2:
        start_time, end_time = m2.group(1), m2.group(2)
    else:
        m3 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, re.I)
        if m3:
            start_time = m3.group(1)

    desc = ""
    for p in soup.find_all("p"):
        c = clean(p.get_text(" ", strip=True))
        if 60 <= len(c) <= 700 and "copyright" not in c.lower() and "quick links" not in c.lower():
            desc = c
            break

    return {
        "source": "darul_islah",
        "source_type": "website",
        "source_url": url,
        "title": title,
        "description": desc,
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_time,
        "location_name": "Darul Islah",
        "address": "320 Fabry Terrace, Teaneck, NJ 07666",
        "city": "Teaneck",
        "state": "NJ",
        "zip": "07666",
        "category": "",
        "audience": "",
        "organizer": "Darul Islah",
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": text[:1200],
        "confidence": 0.78 if date_iso else 0.66,
    }


def unfold_ics_lines(text: str) -> List[str]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: List[str] = []
    for ln in lines:
        if ln.startswith(" ") and out:
            out[-1] += ln[1:]
        else:
            out.append(ln)
    return out


def parse_ics_datetime(raw: str) -> Tuple[str, str]:
    raw = raw.strip()
    if re.fullmatch(r"\d{8}", raw):
        d = datetime.strptime(raw, "%Y%m%d").date().isoformat()
        return d, ""
    raw = raw.rstrip("Z")
    if re.fullmatch(r"\d{8}T\d{6}", raw):
        dt = datetime.strptime(raw, "%Y%m%dT%H%M%S")
        return dt.date().isoformat(), dt.strftime("%H:%M")
    if re.fullmatch(r"\d{8}T\d{4}", raw):
        dt = datetime.strptime(raw, "%Y%m%dT%H%M")
        return dt.date().isoformat(), dt.strftime("%H:%M")
    return "", ""


def parse_ics_file(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = unfold_ics_lines(text)
    events: List[Dict] = []
    block: Dict[str, str] = {}
    in_event = False

    for ln in lines:
        if ln == "BEGIN:VEVENT":
            in_event = True
            block = {}
            continue
        if ln == "END:VEVENT":
            if block:
                summary = clean(block.get("SUMMARY", ""))
                if summary:
                    ds, st = parse_ics_datetime(block.get("DTSTART", ""))
                    de, et = parse_ics_datetime(block.get("DTEND", ""))
                    img_urls = extract_ics_image_urls(block)
                    events.append(
                        {
                            "source": "darul_islah",
                            "source_type": "website",
                            "source_url": clean(block.get("URL", "")) or "ics://darul_islah",
                            "title": summary,
                            "description": clean(block.get("DESCRIPTION", "").replace("\\n", " ")),
                            "date": ds,
                            "start_time": st,
                            "end_time": et if de == ds else et,
                            "location_name": "Darul Islah",
                            "address": clean(block.get("LOCATION", "")) or "320 Fabry Terrace, Teaneck, NJ 07666",
                            "city": "Teaneck",
                            "state": "NJ",
                            "zip": "07666",
                            "category": "",
                            "audience": "",
                            "organizer": "Darul Islah",
                            "rsvp_link": "",
                            "image_urls": img_urls,
                            "raw_text": clean(block.get("DESCRIPTION", ""))[:1200],
                            "confidence": 0.84,
                        }
                    )
            in_event = False
            block = {}
            continue

        if in_event and ":" in ln:
            k, v = ln.split(":", 1)
            k = k.split(";", 1)[0].strip().upper()
            val = v.strip()
            if k in block and block[k]:
                block[k] = block[k] + "\n" + val
            else:
                block[k] = val

    return events


def dedupe(items: List[Dict]) -> List[Dict]:
    seen = set()
    out = []
    for e in items:
        key = (
            clean(e.get("title", "")).lower(),
            e.get("date", ""),
            clean(e.get("start_time", "")).lower(),
            clean(e.get("source_url", "")).lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("title", "")))
    return out


def extract_ics_image_urls(block: Dict[str, str]) -> List[str]:
    urls: List[str] = []
    raw = "\n".join([block.get("ATTACH", ""), block.get("DESCRIPTION", "")])
    for m in re.finditer(r"https?://[^\s\"'<>]+", raw):
        u = clean(m.group(0))
        low = u.lower()
        if any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")):
            if u not in urls:
                urls.append(u)
    return urls[:8]


def newest_local_ics_file() -> Optional[Path]:
    downloads = Path("/Users/shaheersaud/Downloads")
    cands = sorted(downloads.glob(LOCAL_ICS_GLOB), key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pages, event_links, ics_links = discover_pages_and_links(max_pages=40)
    print(f"pages_crawled={len(pages)} event_links={len(event_links)} ics_links={len(ics_links)}")

    scraped: List[Dict] = []
    for i, u in enumerate(event_links, 1):
        ev = parse_event_page(u)
        if ev:
            scraped.append(ev)
        if i % 30 == 0:
            print(f"scraped_details={i}/{len(event_links)}")

    downloaded_ics_events: List[Dict] = []
    seen_ics_links = set()
    # Always try explicit live ICS URLs first.
    for link in LIVE_ICS_URLS + ics_links:
        if link in seen_ics_links:
            continue
        seen_ics_links.add(link)
        b = fetch_bytes(link, timeout=25, tries=2)
        if b and (b.startswith(b"BEGIN:VCALENDAR") or b"BEGIN:VCALENDAR" in b[:200]):
            DOWNLOADED_ICS.write_bytes(b)
            downloaded_ics_events.extend(parse_ics_file(DOWNLOADED_ICS))
            print(f"downloaded_ics={link}")
            # Keep first successful canonical feed and stop.
            break

    local_ics_events: List[Dict] = []
    local_ics = newest_local_ics_file()
    if local_ics:
        local_ics_events = parse_ics_file(local_ics)
        print(f"local_ics_file={local_ics}")
    print(f"local_ics_events={len(local_ics_events)} downloaded_ics_events={len(downloaded_ics_events)} scraped={len(scraped)}")

    merged = dedupe(scraped + downloaded_ics_events + local_ics_events)
    OUT_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"saved={OUT_JSON} total={len(merged)}")
    print(
        "blank_desc=", sum(1 for e in merged if not e.get("description")),
        "blank_date=", sum(1 for e in merged if not e.get("date")),
        "blank_start=", sum(1 for e in merged if not e.get("start_time")),
    )


if __name__ == "__main__":
    main()
