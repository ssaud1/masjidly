#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml
#
# Usage:
#   .venv/bin/python refresh_alfalah_events.py
#
# Output:
#   events_by_masjid/alfalah_events.json
#
# Notes:
# - Reads Al Falah's Madina calendar data (same source behind day-click UI)
# - Uses API first, then falls back to inline `var json = [...]` payloads

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import requests
from bs4 import BeautifulSoup

BASE_EVENTS_URL = "https://alfalahcenter.org/events/"
MADINA_API_TEMPLATE = "https://services.madinaapps.com/kiosk-rest/clients/{client_id}/events"
OUT_DIR = Path("/Users/shaheersaud/Safar/events_by_masjid")
OUT_JSON = OUT_DIR / "alfalah_events.json"
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


def fetch_text(url: str, timeout: int = 30) -> Optional[str]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code == 200:
            return r.text
    except requests.RequestException:
        return None
    return None


def parse_day_label_to_iso(day_label: str) -> str:
    txt = clean(day_label)
    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(txt, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def parse_datetime_value(raw: str) -> tuple[str, str]:
    txt = clean(raw)
    if not txt:
        return "", ""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(txt, fmt)
            return dt.date().isoformat(), dt.strftime("%H:%M")
        except ValueError:
            continue
    return "", ""


def parse_time_value(raw: str) -> str:
    txt = clean(raw).lower().replace(".", "")
    if not txt:
        return ""
    for fmt in ("%I:%M %p", "%I %p", "%H:%M"):
        try:
            return datetime.strptime(txt.upper(), fmt).strftime("%H:%M")
        except ValueError:
            continue
    return ""


def strip_html(value: str) -> str:
    txt = clean(value)
    if not txt:
        return ""
    return clean(BeautifulSoup(txt, "lxml").get_text(" ", strip=True))


def normalize_url(value: str) -> str:
    u = clean(value).replace("\\/", "/")
    if u.startswith("http://") or u.startswith("https://"):
        return u
    return ""


def build_event(raw: Dict, default_date_iso: str, source_url: str) -> Optional[Dict]:
    title = clean(str(raw.get("eventTitle") or raw.get("title") or ""))
    if not title:
        return None

    start_date_iso, start_time = parse_datetime_value(str(raw.get("eventStartDate") or raw.get("start") or ""))
    end_date_iso, end_time = parse_datetime_value(str(raw.get("eventEndDate") or raw.get("end") or ""))
    date_iso = start_date_iso or default_date_iso
    if not start_time:
        start_time = parse_time_value(str(raw.get("fromTime") or ""))
    if not end_time:
        end_time = parse_time_value(str(raw.get("toTime") or ""))
    if not date_iso:
        return None

    description = clean(
        strip_html(str(raw.get("eventDescription") or raw.get("description") or ""))
        or strip_html(str(raw.get("eventPreRequisite") or ""))
    )
    category = clean(str(raw.get("eventCategory") or ""))
    audience = clean(str(raw.get("intendedAudience") or raw.get("audience") or ""))
    rsvp_link = normalize_url(str(raw.get("eventActionUrl") or ""))
    banner = normalize_url(str(raw.get("eventBannerImage") or ""))
    source_event_id = clean(str(raw.get("eventId") or ""))
    event_location = clean(str(raw.get("eventLocation") or ""))

    item_source_url = source_url
    if source_event_id:
        item_source_url = f"{BASE_EVENTS_URL}#event-{source_event_id}"

    return {
        "source": "alfalah",
        "source_type": "website",
        "source_url": item_source_url,
        "title": title,
        "description": description,
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_time if (not end_date_iso or end_date_iso == date_iso) else end_time,
        "location_name": "Masjid Al Falah Center",
        "address": "881 Route 206, Bridgewater, NJ 08807",
        "city": "Bridgewater",
        "state": "NJ",
        "zip": "08807",
        "category": category,
        "audience": audience,
        "organizer": "Masjid Al Falah Center",
        "rsvp_link": rsvp_link,
        "image_urls": [banner] if banner else [],
        "raw_text": clean(
            " | ".join(
                x
                for x in [
                    description,
                    category,
                    audience,
                    event_location,
                    clean(str(raw.get("eventActionText") or "")),
                ]
                if x
            )
        )[:1200],
        "confidence": 0.98 if start_time else 0.92,
    }


def extract_client_id(page_html: str) -> str:
    # Prefer IDs tied to event media URLs in the payload.
    ids = re.findall(r"client_(\d+)", page_html or "")
    if ids:
        return Counter(ids).most_common(1)[0][0]
    return ""


def extract_inline_json_arrays(page_html: str) -> List[List[Dict]]:
    out: List[List[Dict]] = []
    for m in re.finditer(r"var\s+json\s*=\s*(\[[\s\S]*?\]);", page_html or "", re.S):
        blob = m.group(1)
        try:
            arr = json.loads(blob)
            if isinstance(arr, list):
                out.append(arr)
        except Exception:
            continue
    return out


def fetch_api_events(client_id: str, from_date: str, to_date: str) -> List[Dict]:
    if not client_id:
        return []
    url = MADINA_API_TEMPLATE.format(client_id=client_id)
    try:
        r = requests.get(
            url,
            params={"fromDate": from_date, "toDate": to_date},
            headers=HEADERS,
            timeout=30,
        )
        if r.status_code != 200:
            return []
        payload = r.json()
    except Exception:
        return []

    out: List[Dict] = []
    if not isinstance(payload, list):
        return out
    for day_row in payload:
        if not isinstance(day_row, dict):
            continue
        date_iso = parse_day_label_to_iso(str(day_row.get("date") or ""))
        events = day_row.get("dayEvents") or []
        if not isinstance(events, list):
            continue
        for raw in events:
            if not isinstance(raw, dict):
                continue
            built = build_event(raw, date_iso, BASE_EVENTS_URL)
            if built:
                out.append(built)
    return out


def parse_inline_events(page_html: str) -> List[Dict]:
    rows: List[Dict] = []
    arrays = extract_inline_json_arrays(page_html)
    for arr in arrays:
        for raw in arr:
            if not isinstance(raw, dict):
                continue
            default_date_iso, _ = parse_datetime_value(str(raw.get("start") or ""))
            built = build_event(raw, default_date_iso, BASE_EVENTS_URL)
            if built:
                rows.append(built)
    return rows


def dedupe(items: Iterable[Dict]) -> List[Dict]:
    out: List[Dict] = []
    seen = set()
    for e in items:
        key = (
            clean(e.get("title", "")).lower(),
            clean(e.get("date", "")),
            clean(e.get("start_time", "")),
            clean(e.get("rsvp_link", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date", "9999-12-31"), x.get("start_time", "99:99"), x.get("title", "")))
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    html = fetch_text(BASE_EVENTS_URL) or ""
    if not html:
        raise SystemExit("failed_to_fetch_events_page")

    today = date.today()
    from_date = date(today.year, today.month, 1).isoformat()
    to_date = (date(today.year, today.month, 1) + timedelta(days=430)).isoformat()
    client_id = extract_client_id(html)
    api_events = fetch_api_events(client_id, from_date=from_date, to_date=to_date)
    inline_events = parse_inline_events(html)

    merged = dedupe(api_events + inline_events)
    OUT_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"client_id={client_id or 'unknown'} api_events={len(api_events)} inline_events={len(inline_events)}")
    print(f"saved={OUT_JSON} total={len(merged)}")


if __name__ == "__main__":
    main()
