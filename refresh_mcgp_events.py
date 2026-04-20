#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml playwright
#   playwright install chromium
#
# Usage:
#   .venv/bin/python refresh_mcgp_events.py
#
# Output:
#   events_by_masjid/mcgp_events.json
#   events_by_masjid/mcgp_latest.ics (if discoverable)

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://www.themuslimcenter.org/"
EVENT_LIST_URL = "https://www.themuslimcenter.org/event-list"
OUT_DIR = Path("/Users/shaheersaud/Safar/events_by_masjid")
OUT_JSON = OUT_DIR / "mcgp_events.json"
DOWNLOADED_ICS = OUT_DIR / "mcgp_latest.ics"
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


def fetch_text(url: str, timeout: int = 20, tries: int = 2) -> Optional[str]:
    for _ in range(tries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            if r.status_code == 200 and "text/html" in (r.headers.get("Content-Type", "").lower()):
                return r.text
        except requests.RequestException:
            pass
    return None


def fetch_bytes(url: str, timeout: int = 20, tries: int = 2) -> Optional[bytes]:
    for _ in range(tries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            if r.status_code == 200:
                return r.content
        except requests.RequestException:
            pass
    return None


def parse_ics_datetime(raw: str) -> (str, str):
    raw = raw.strip().rstrip("Z")
    if re.fullmatch(r"\d{8}", raw):
        d = datetime.strptime(raw, "%Y%m%d").date().isoformat()
        return d, ""
    if re.fullmatch(r"\d{8}T\d{6}", raw):
        dt = datetime.strptime(raw, "%Y%m%dT%H%M%S")
        return dt.date().isoformat(), dt.strftime("%H:%M")
    if re.fullmatch(r"\d{8}T\d{4}", raw):
        dt = datetime.strptime(raw, "%Y%m%dT%H%M")
        return dt.date().isoformat(), dt.strftime("%H:%M")
    return "", ""


def unfold_ics_lines(text: str) -> List[str]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: List[str] = []
    for ln in lines:
        if ln.startswith(" ") and out:
            out[-1] += ln[1:]
        else:
            out.append(ln)
    return out


def parse_ics_file(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = unfold_ics_lines(text)
    out: List[Dict] = []
    block: Dict[str, str] = {}
    in_event = False
    for ln in lines:
        if ln == "BEGIN:VEVENT":
            in_event = True
            block = {}
            continue
        if ln == "END:VEVENT":
            if block.get("SUMMARY"):
                ds, st = parse_ics_datetime(block.get("DTSTART", ""))
                de, et = parse_ics_datetime(block.get("DTEND", ""))
                out.append(
                    {
                        "source": "mcgp",
                        "source_type": "website",
                        "source_url": clean(block.get("URL", "")) or "ics://mcgp",
                        "title": clean(block.get("SUMMARY", "")),
                        "description": clean(block.get("DESCRIPTION", "").replace("\\n", " ")),
                        "date": ds,
                        "start_time": st,
                        "end_time": et if de == ds else et,
                        "location_name": "Muslim Center of Greater Princeton",
                        "address": clean(block.get("LOCATION", "")) or "2030 Old Trenton Rd, West Windsor, NJ 08550",
                        "city": "West Windsor",
                        "state": "NJ",
                        "zip": "08550",
                        "category": "",
                        "audience": "",
                        "organizer": "Muslim Center of Greater Princeton",
                        "rsvp_link": "",
                        "image_urls": [],
                        "raw_text": clean(block.get("DESCRIPTION", ""))[:1200],
                        "confidence": 0.86,
                    }
                )
            in_event = False
            block = {}
            continue
        if in_event and ":" in ln:
            k, v = ln.split(":", 1)
            k = k.split(";", 1)[0].strip().upper()
            block[k] = v.strip()
    return out


def parse_event_list() -> (List[Dict], List[str], List[str]):
    html = fetch_text(EVENT_LIST_URL)
    if not html:
        return [], [], []
    soup = BeautifulSoup(html, "lxml")

    detail_links = []
    ics_links = []
    for a in soup.find_all("a", href=True):
        full = urljoin(EVENT_LIST_URL, a["href"].strip())
        low = full.lower()
        if "/event-details/" in low:
            if full not in detail_links:
                detail_links.append(full)
        if ".ics" in low or "ical=1" in low or "outlook-ical" in low:
            if full not in ics_links:
                ics_links.append(full)

    events: List[Dict] = []
    seen_titles = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        full = urljoin(EVENT_LIST_URL, href)
        if "/event-details/" not in full.lower():
            continue
        title = clean(a.get_text(" ", strip=True))
        if not title or title.lower() == "details":
            continue
        if title.lower() in seen_titles:
            continue
        seen_titles.add(title.lower())

        card = a.parent
        context = clean(card.get_text(" ", strip=True)) if card else title
        date_text = ""
        m = re.search(r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Za-z]{3}\s+\d{1,2}\b", context, re.I)
        if m:
            date_text = m.group(0)

        events.append(
            {
                "source": "mcgp",
                "source_type": "website",
                "source_url": full,
                "title": title,
                "description": context[:300],
                "date": "",
                "start_time": "",
                "end_time": "",
                "location_name": "Muslim Center of Greater Princeton",
                "address": "2030 Old Trenton Rd, West Windsor, NJ 08550",
                "city": "West Windsor",
                "state": "NJ",
                "zip": "08550",
                "category": "",
                "audience": "",
                "organizer": "Muslim Center of Greater Princeton",
                "rsvp_link": "",
                "image_urls": [],
                "raw_text": date_text,
                "confidence": 0.56,
            }
        )
    return events, detail_links, ics_links


def parse_event_detail(url: str) -> Optional[Dict]:
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

    text = clean(soup.get_text(" ", strip=True))
    desc = ""
    for p in soup.find_all("p"):
        c = clean(p.get_text(" ", strip=True))
        if 70 <= len(c) <= 700:
            desc = c
            break

    start_time = ""
    end_time = ""
    m = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\s*[-–]\s*(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, re.I)
    if m:
        start_time, end_time = m.group(1), m.group(2)
    else:
        m2 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, re.I)
        if m2:
            start_time = m2.group(1)

    date_iso = ""
    mm = re.search(r"(20\d{2}-\d{2}-\d{2})", url)
    if mm:
        date_iso = mm.group(1)

    return {
        "source": "mcgp",
        "source_type": "website",
        "source_url": url,
        "title": title,
        "description": desc,
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_time,
        "location_name": "Muslim Center of Greater Princeton",
        "address": "2030 Old Trenton Rd, West Windsor, NJ 08550",
        "city": "West Windsor",
        "state": "NJ",
        "zip": "08550",
        "category": "",
        "audience": "",
        "organizer": "Muslim Center of Greater Princeton",
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": text[:1200],
        "confidence": 0.68 if date_iso else 0.61,
    }


def dedupe(items: List[Dict]) -> List[Dict]:
    seen = set()
    out = []
    for e in items:
        key = (
            clean(e.get("title", "")).lower(),
            e.get("date", ""),
            clean(e.get("source_url", "")).lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("title", "")))
    return out


def parse_panel_date(date_text: str, month_year_fallback: str) -> str:
    # Example: "Thursday, 02 April"
    dt = clean(date_text)
    m = re.search(r"\b(\d{1,2})\s+([A-Za-z]+)\b", dt)
    if not m:
        return ""
    day = int(m.group(1))
    mon_name = m.group(2)
    y_match = re.search(r"\b(20\d{2})\b", month_year_fallback)
    if not y_match:
        return ""
    year = int(y_match.group(1))
    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(f"{day} {mon_name} {year}", fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def parse_panel_time(time_text: str) -> (str, str):
    txt = clean(time_text)
    m = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\s*[-–]\s*(\d{1,2}:\d{2}\s?(?:am|pm))\b", txt, re.I)
    if m:
        return m.group(1), m.group(2)
    m2 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\b", txt, re.I)
    if m2:
        return m2.group(1), ""
    return "", ""


def parse_iso_datetime(value: str) -> Optional[datetime]:
    txt = clean(value)
    if not txt:
        return None
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(txt, fmt)
        except ValueError:
            continue
    return None


def parse_media_urls(*values: object) -> List[str]:
    urls: List[str] = []

    def add_url(candidate: str) -> None:
        u = clean(candidate).replace("\\/", "/")
        if u.startswith("http://") or u.startswith("https://"):
            if u not in urls:
                urls.append(u)

    def walk(v: object) -> None:
        if v is None:
            return
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return
            # Raw URL.
            if s.startswith("http://") or s.startswith("https://"):
                add_url(s)
                return
            # JSON-encoded list/object or escaped string.
            if (s.startswith("[") and s.endswith("]")) or (s.startswith("{") and s.endswith("}")):
                try:
                    parsed = json.loads(s)
                    walk(parsed)
                    return
                except Exception:
                    pass
            # Fallback: regex scrape URLs from text blobs.
            for m in re.finditer(r"https?://[^\s\"'>]+", s):
                add_url(m.group(0))
            return
        if isinstance(v, list):
            for x in v:
                walk(x)
            return
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
            return

    for value in values:
        walk(value)
    return urls


def expand_weekly_occurrence_dates(start_raw: str, repeat: Dict) -> List[str]:
    """
    Expand weekly recurrence into concrete ISO dates.
    Falls back to base start date only if recurrence metadata is incomplete.
    """
    start_dt = parse_iso_datetime(start_raw)
    if not start_dt:
        return []

    repeat_type = clean(str((repeat or {}).get("type", ""))).lower()
    if repeat_type != "week":
        return [start_dt.date().isoformat()]

    interval_raw = clean(str((repeat or {}).get("interval", ""))) or "1"
    try:
        interval_weeks = max(1, int(interval_raw))
    except ValueError:
        interval_weeks = 1

    end_raw = clean(str((repeat or {}).get("end", "")))
    end_dt = parse_iso_datetime(end_raw) if end_raw else None
    if not end_dt:
        return [start_dt.date().isoformat()]

    excludes = set()
    ex_val = (repeat or {}).get("exclude", [])
    if isinstance(ex_val, list):
        for x in ex_val:
            d = parse_iso_datetime(str(x))
            if d:
                excludes.add(d.date().isoformat())

    out: List[str] = []

    # Boom advanced weekdays use JS-style day indexes (0=Sun ... 6=Sat).
    advanced = (repeat or {}).get("advanced", [])
    target_weekdays: List[int] = []
    if isinstance(advanced, list) and advanced:
        for x in advanced:
            try:
                day = int(str(x))
                if 0 <= day <= 6:
                    target_weekdays.append(day)
            except ValueError:
                continue
    # If advanced is missing, use start date's weekday.
    if not target_weekdays:
        # Python weekday: Mon=0..Sun=6; convert to JS: Sun=0..Sat=6
        py = start_dt.weekday()
        js = (py + 1) % 7
        target_weekdays = [js]

    cur = start_dt
    while cur.date() <= end_dt.date():
        week_start = cur.date()
        for js_day in sorted(set(target_weekdays)):
            # Convert JS day back to Python offset from Monday-based week.
            py_day = (js_day + 6) % 7
            delta = py_day - week_start.weekday()
            cand = datetime.combine(week_start + timedelta(days=delta), datetime.min.time())
            if cand < start_dt or cand.date() > end_dt.date():
                continue
            ds = cand.date().isoformat()
            if ds not in excludes:
                out.append(ds)
        cur += timedelta(weeks=interval_weeks)

    # Include any explicitly added dates.
    add_val = (repeat or {}).get("additionalDates", [])
    if isinstance(add_val, list):
        for x in add_val:
            d = parse_iso_datetime(str(x))
            if d:
                ds = d.date().isoformat()
                if ds not in out and ds not in excludes:
                    out.append(ds)

    return sorted(set(out))


def scrape_dynamic_calendar_playwright() -> List[Dict]:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except Exception:
        print("playwright_unavailable=1")
        return []

    extracted: List[Dict] = []
    seen = set()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 2600})
        page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
        page.mouse.wheel(0, 7000)
        page.wait_for_timeout(3500)

        cal_frames = [f for f in page.frames if "calendar.boomte.ch/widget" in f.url]
        if not cal_frames:
            browser.close()
            print("dynamic_calendar_found=0")
            return []
        cal = cal_frames[0]

        # Preferred path: fetch direct published calendar JSON feed used by the widget.
        q = parse_qs(urlparse(cal.url).query)
        comp_id = q.get("compId", [""])[0]
        instance = q.get("instance", [""])[0]
        tz = q.get("tz", ["America/New_York"])[0]
        api_url = "https://calendar.apiboomtech.com/api/published_calendar"
        try:
            r = requests.get(
                api_url,
                params={
                    "comp_id": comp_id,
                    "instance": instance,
                    "originCompId": "",
                    "time_zone": tz,
                },
                headers=HEADERS,
                timeout=25,
            )
            if r.status_code == 200:
                payload = r.json()
                categories = {
                    str(c.get("id")): clean(c.get("name", ""))
                    for c in (payload.get("categories") or [])
                    if isinstance(c, dict)
                }
                api_events = payload.get("events") or []
                print(f"dynamic_api_events={len(api_events)}")
                for ev in api_events:
                    if not isinstance(ev, dict):
                        continue
                    title = clean(ev.get("title", ""))
                    if not title:
                        continue
                    start_raw = clean(ev.get("start", ""))
                    end_raw = clean(ev.get("end", ""))
                    base_date_iso = start_raw[:10] if re.match(r"\d{4}-\d{2}-\d{2}", start_raw) else ""
                    st = start_raw.split("T", 1)[1][:5] if "T" in start_raw else ""
                    en = end_raw.split("T", 1)[1][:5] if "T" in end_raw else ""

                    venue = ev.get("venue") or {}
                    addr = clean(venue.get("address", "")) if isinstance(venue, dict) else ""
                    city = clean(venue.get("city", "")) if isinstance(venue, dict) else ""
                    postal = clean(venue.get("postal", "")) if isinstance(venue, dict) else ""
                    state = clean(venue.get("statesList", "")) if isinstance(venue, dict) else ""

                    desc_html = ev.get("desc", "") or ""
                    desc = clean(BeautifulSoup(desc_html, "lxml").get_text(" ", strip=True)) if desc_html else ""
                    desc_image_urls = []
                    if desc_html:
                        desc_soup = BeautifulSoup(desc_html, "lxml")
                        for img in desc_soup.find_all("img", src=True):
                            src = clean(img.get("src", ""))
                            if src:
                                desc_image_urls.append(src)

                    rsvp_link = ""
                    reg = ev.get("registration")
                    if isinstance(reg, dict):
                        rsvp_link = clean(reg.get("url", "") or reg.get("link", ""))
                    link = ev.get("link")
                    if not rsvp_link and isinstance(link, dict):
                        link_url = clean(link.get("url", ""))
                        # Wix stores a nested JSON string in link.url at times.
                        if link_url.startswith("{") and "\"url\"" in link_url:
                            try:
                                parsed = json.loads(link_url)
                                rsvp_link = clean(parsed.get("url", ""))
                            except Exception:
                                pass
                        elif link_url.startswith("http"):
                            rsvp_link = link_url

                    cat_name = ""
                    cat_ids = ev.get("categories")
                    if isinstance(cat_ids, list) and cat_ids:
                        cat_name = categories.get(str(cat_ids[0]), "")
                    elif isinstance(cat_ids, (str, int)):
                        cat_name = categories.get(str(cat_ids), "")

                    poster_urls = parse_media_urls(
                        ev.get("image", ""),
                        ev.get("attachments", []),
                        desc_image_urls,
                    )

                    occurrence_dates = expand_weekly_occurrence_dates(start_raw, ev.get("repeat") or {})
                    if not occurrence_dates and base_date_iso:
                        occurrence_dates = [base_date_iso]

                    for date_iso in occurrence_dates:
                        key = (title.lower(), date_iso, st, clean(addr).lower())
                        if key in seen:
                            continue
                        seen.add(key)
                        extracted.append(
                            {
                                "source": "mcgp",
                                "source_type": "website",
                                "source_url": f"{BASE.rstrip('/')}/#calendar-event-{ev.get('id', '')}",
                                "title": title,
                                "description": desc,
                                "date": date_iso,
                                "start_time": st,
                                "end_time": en,
                                "location_name": "Muslim Center of Greater Princeton",
                                "address": addr or "2030 Old Trenton Rd, West Windsor, NJ 08550",
                                "city": city or "West Windsor",
                                "state": state or "NJ",
                                "zip": postal or "08550",
                                "category": cat_name,
                                "audience": "",
                                "organizer": "Muslim Center of Greater Princeton",
                                "rsvp_link": rsvp_link,
                                "image_urls": poster_urls,
                                "raw_text": desc[:1200],
                                "confidence": 0.97 if date_iso else 0.88,
                            }
                        )
                browser.close()
                return extracted
        except Exception:
            pass

        # Fallback path: direct click extraction if API retrieval fails.
        if cal.locator(".fc-dayGridMonth-button").count():
            cal.locator(".fc-dayGridMonth-button").first.click()
            cal.wait_for_timeout(800)

        month_label = clean(cal.locator(".fc-toolbar-title").first.inner_text() if cal.locator(".fc-toolbar-title").count() else "")
        total = cal.locator(".fc-daygrid-event").count()
        print(f"dynamic_calendar_found=1 event_nodes={total} month='{month_label}'")
        if total == 0:
            browser.close()
            return []

        for i in range(total):
            try:
                event_nodes = cal.locator(".fc-daygrid-event")
                if i >= event_nodes.count():
                    break
                node = event_nodes.nth(i)
                node_title = clean(node.locator(".fc-event-title").first.inner_text() if node.locator(".fc-event-title").count() else "")
                node.click(timeout=4000)
                page.wait_for_timeout(1000)

                modal_frames = [f for f in page.frames if "calendar.boomte.ch/event-modal" in f.url]
                if not modal_frames:
                    continue
                modal = modal_frames[-1]
                modal.wait_for_timeout(300)
                if modal.locator(".event_info").count() == 0:
                    continue

                panel = modal.locator(".event_info").first
                p_title = clean(panel.locator(".header.title").first.inner_text() if panel.locator(".header.title").count() else node_title)
                panel_text = clean(panel.inner_text())

                # Parse date/time from panel details.
                details_vals = [clean(panel.locator(".details p").nth(j).inner_text()) for j in range(panel.locator(".details p").count())]
                date_text = ""
                time_text = ""
                for val in details_vals:
                    if any(day in val.lower() for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")):
                        date_text = val
                    if re.search(r"\d{1,2}:\d{2}\s?(?:am|pm)", val, re.I):
                        time_text = val
                date_iso = parse_panel_date(date_text, month_label)
                st, en = parse_panel_time(time_text)

                addr = ""
                desc = ""
                if panel.locator(".details.link span").count() > 0:
                    addr = clean(panel.locator(".details.link span").last.inner_text())
                if panel.locator(".description").count() > 0:
                    desc = clean(panel.locator(".description").first.inner_text())

                # Discover canonical link if present in modal text.
                rsvp_link = ""
                url_match = re.search(r"https?://[^\s]+", panel_text)
                if url_match:
                    rsvp_link = clean(url_match.group(0))

                key = (p_title.lower(), date_iso, st, addr.lower())
                if key not in seen:
                    seen.add(key)
                    extracted.append(
                        {
                            "source": "mcgp",
                            "source_type": "website",
                            "source_url": BASE.rstrip("/") + "#calendar",
                            "title": p_title,
                            "description": desc,
                            "date": date_iso,
                            "start_time": st,
                            "end_time": en,
                            "location_name": "Muslim Center of Greater Princeton",
                            "address": addr or "2030 Old Trenton Rd, West Windsor, NJ 08550",
                            "city": "West Windsor",
                            "state": "NJ",
                            "zip": "08550",
                            "category": "",
                            "audience": "",
                            "organizer": "Muslim Center of Greater Princeton",
                            "rsvp_link": rsvp_link,
                            "image_urls": [],
                            "raw_text": panel_text[:1200],
                            "confidence": 0.92 if date_iso else 0.8,
                        }
                    )

                # Close modal for next event.
                if modal.locator("button[aria-label='Close']").count():
                    modal.locator("button[aria-label='Close']").first.click()
                elif modal.locator(".icon-cross").count():
                    modal.locator(".icon-cross").first.click()
                else:
                    page.keyboard.press("Escape")
                page.wait_for_timeout(350)
            except Exception:
                continue

        browser.close()
    return extracted


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    list_events, detail_links, discovered_ics = parse_event_list()
    print(f"list_events={len(list_events)} detail_links={len(detail_links)} discovered_ics={len(discovered_ics)}")

    detail_events = []
    for i, u in enumerate(detail_links, 1):
        ev = parse_event_detail(u)
        if ev:
            detail_events.append(ev)
        if i % 10 == 0:
            print(f"parsed_detail={i}/{len(detail_links)}")

    ics_events: List[Dict] = []
    downloaded = False
    for link in discovered_ics:
        b = fetch_bytes(link, timeout=20, tries=2)
        if b and (b.startswith(b"BEGIN:VCALENDAR") or b"BEGIN:VCALENDAR" in b[:200]):
            DOWNLOADED_ICS.write_bytes(b)
            ics_events.extend(parse_ics_file(DOWNLOADED_ICS))
            downloaded = True
            print(f"downloaded_ics={link}")
            break
    if not downloaded:
        print("downloaded_ics=none_found")

    dynamic_events = scrape_dynamic_calendar_playwright()
    print(f"dynamic_events={len(dynamic_events)}")

    merged = dedupe(list_events + detail_events + ics_events + dynamic_events)
    OUT_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"saved={OUT_JSON} total={len(merged)}")
    print(f"blank_desc={sum(1 for e in merged if not e.get('description'))} blank_date={sum(1 for e in merged if not e.get('date'))}")


if __name__ == "__main__":
    main()
