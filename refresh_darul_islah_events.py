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
#
# Performance/resilience controls (2026 refactor):
# - Hard wall-clock cap (DARUL_MAX_RUNTIME_SECONDS, default 300s) so the
#   script self-aborts on a slow origin instead of stalling the pipeline.
# - Short HTTP timeouts (6s) with one retry, to fail fast on dead pages.
# - Per-URL date prefilter: only fetch detail pages for upcoming events
#   (dated URLs like /events/2026-05-01/...). Undated slugs are fetched
#   but counted against the runtime cap.
# - Newest-first iteration so if we hit the cap, the upcoming events are
#   scraped before we give up.
# - Verbose progress prints flushed every page so GHA live logs show
#   whether we're progressing or genuinely hung.

from __future__ import annotations

import json
import os
import re
import time
from collections import deque
from datetime import datetime, date
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin, urlparse

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

# Fail fast on a slow origin rather than stalling the daily pipeline.
MAX_RUNTIME_SECONDS = int(os.getenv("DARUL_MAX_RUNTIME_SECONDS", "300"))
HTTP_TIMEOUT = int(os.getenv("DARUL_HTTP_TIMEOUT", "6"))
HTTP_TRIES = int(os.getenv("DARUL_HTTP_TRIES", "1"))
MAX_CRAWL_PAGES = int(os.getenv("DARUL_MAX_CRAWL_PAGES", "40"))
# 0 = unlimited (use runtime cap); otherwise a hard cap on how many detail
# pages we'll fetch even if we have time left. Keeps the fetch predictable.
MAX_DETAIL_PAGES = int(os.getenv("DARUL_MAX_DETAIL_PAGES", "60"))

# darulislah.org blocks GitHub Actions IP ranges on direct connections
# (observed: all HTTPS requests ConnectTimeout at 6s from ubuntu-latest
# runners). Route through the same Webshare proxy pool the Instagram
# scraper uses. Reads newline-separated proxy URLs / Webshare
# host:port:user:password lines. Falls back to direct connection if
# unset or empty; the wall-clock budget still protects the pipeline.
PROXY_FILE = os.getenv("DARUL_PROXY_FILE", os.getenv("SAFAR_INSTAGRAM_PROXY_FILE", "webshare_proxies.txt"))

_RUN_STARTED = time.perf_counter()


def _normalize_proxy_line(raw: str) -> str:
    """Accept full proxy URLs or Webshare host:port:user:password lines."""
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


def _redact_proxy(url: str) -> str:
    """Hide user:pass when logging the proxy URL."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname or "?"
        port = parsed.port or "?"
        return f"{parsed.scheme}://<redacted>@{host}:{port}"
    except Exception:
        return "<proxy?>"


def _load_proxy() -> Optional[Dict[str, str]]:
    """Return a requests-compatible proxies={'http':..,'https':..} dict, or None."""
    raw = (PROXY_FILE or "").strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        # Resolve relative to script location so the daily pipeline's
        # cwd=/Users/shaheersaud/Safar still finds it in GHA after symlink.
        p = Path(__file__).resolve().parent / raw
    if not p.exists():
        print(f"[darul_islah] proxy file not found: {p} — using direct connection", flush=True)
        return None
    for ln in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        norm = _normalize_proxy_line(ln)
        if norm:
            print(f"[darul_islah] using proxy {_redact_proxy(norm)}", flush=True)
            return {"http": norm, "https": norm}
    print(f"[darul_islah] proxy file {p} has no usable lines — using direct", flush=True)
    return None


_PROXIES = _load_proxy()


def _elapsed() -> float:
    return round(time.perf_counter() - _RUN_STARTED, 1)


def _out_of_budget(label: str = "") -> bool:
    el = _elapsed()
    if el >= MAX_RUNTIME_SECONDS:
        suffix = f" ({label})" if label else ""
        print(
            f"[darul_islah] BUDGET_EXCEEDED elapsed={el}s "
            f"cap={MAX_RUNTIME_SECONDS}s — bailing early{suffix}",
            flush=True,
        )
        return True
    return False


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def fetch_text(url: str, timeout: int = HTTP_TIMEOUT, tries: int = HTTP_TRIES) -> Optional[str]:
    for attempt in range(tries + 1):
        t0 = time.perf_counter()
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout, proxies=_PROXIES)
            dt_ms = int((time.perf_counter() - t0) * 1000)
            if r.status_code == 200:
                return r.text
            print(
                f"[darul_islah] http={r.status_code} in {dt_ms}ms attempt={attempt + 1} "
                f"url={url[:100]}",
                flush=True,
            )
        except requests.RequestException as exc:
            dt_ms = int((time.perf_counter() - t0) * 1000)
            print(
                f"[darul_islah] http=ERR in {dt_ms}ms attempt={attempt + 1} "
                f"err={type(exc).__name__} url={url[:100]}",
                flush=True,
            )
    return None


def fetch_bytes(url: str, timeout: int = HTTP_TIMEOUT, tries: int = HTTP_TRIES) -> Optional[bytes]:
    for attempt in range(tries + 1):
        t0 = time.perf_counter()
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout, proxies=_PROXIES)
            dt_ms = int((time.perf_counter() - t0) * 1000)
            if r.status_code == 200:
                return r.content
            print(
                f"[darul_islah] ics_http={r.status_code} in {dt_ms}ms attempt={attempt + 1} "
                f"url={url[:100]}",
                flush=True,
            )
        except requests.RequestException as exc:
            dt_ms = int((time.perf_counter() - t0) * 1000)
            print(
                f"[darul_islah] ics_http=ERR in {dt_ms}ms attempt={attempt + 1} "
                f"err={type(exc).__name__} url={url[:100]}",
                flush=True,
            )
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


_URL_DATE_RE = re.compile(r"/events/(\d{4}-\d{2}-\d{2})(?:/|$)")


def url_event_date(url: str) -> Optional[date]:
    """Parse the YYYY-MM-DD out of a Tribe Events detail URL, if present."""
    m = _URL_DATE_RE.search(url)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d").date()
    except ValueError:
        return None


def discover_pages_and_links(max_pages: int = MAX_CRAWL_PAGES) -> Tuple[List[str], List[str], List[str]]:
    queue = deque(STARTS)
    seen_pages = set()
    event_links = set()
    ics_links = set()
    crawled_pages: List[str] = []

    print(
        f"[darul_islah] STAGE discover max_pages={max_pages} "
        f"timeout={HTTP_TIMEOUT}s tries={HTTP_TRIES + 1} budget={MAX_RUNTIME_SECONDS}s",
        flush=True,
    )

    while queue and len(crawled_pages) < max_pages:
        if _out_of_budget("discover"):
            break
        u = queue.popleft()
        if u in seen_pages:
            continue
        seen_pages.add(u)

        html = fetch_text(u)
        if not html:
            print(
                f"[darul_islah] crawled={len(crawled_pages)}/{max_pages} "
                f"queue={len(queue)} miss={u[:80]} elapsed={_elapsed()}s",
                flush=True,
            )
            continue
        crawled_pages.append(u)
        soup = BeautifulSoup(html, "lxml")

        added_details = 0
        added_ics = 0
        added_queue = 0
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            full = urljoin(u, href)
            if not full.startswith(BASE):
                continue
            low = full.lower()

            if is_event_detail(full):
                norm = full.rstrip("/")
                if norm not in event_links:
                    event_links.add(norm)
                    added_details += 1

            if ".ics" in low or "ical=1" in low or "outlook-ical" in low:
                if full not in ics_links:
                    ics_links.add(full)
                    added_ics += 1

            if ("/events/list/page/" in low or "eventdisplay=past" in low or "tribe-bar-date=" in low) and full not in seen_pages:
                queue.append(full)
                added_queue += 1

        print(
            f"[darul_islah] crawled={len(crawled_pages)}/{max_pages} "
            f"queue={len(queue)} (+{added_queue}) event_links={len(event_links)} "
            f"(+{added_details}) ics={len(ics_links)} (+{added_ics}) "
            f"elapsed={_elapsed()}s page={u[:70]}",
            flush=True,
        )

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
    if not downloads.exists():
        return None
    cands = sorted(downloads.glob(LOCAL_ICS_GLOB), key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def filter_and_rank_event_links(event_links: List[str]) -> List[str]:
    """Keep only upcoming-or-undated URLs, ranked by extracted date DESC (soonest first)."""
    today = date.today()
    upcoming: List[Tuple[date, str]] = []
    undated: List[str] = []
    dropped_past = 0
    for u in event_links:
        d = url_event_date(u)
        if d is None:
            undated.append(u)
        elif d >= today:
            upcoming.append((d, u))
        else:
            dropped_past += 1
    upcoming.sort(key=lambda x: x[0])
    print(
        f"[darul_islah] filter_event_links input={len(event_links)} "
        f"upcoming={len(upcoming)} undated={len(undated)} dropped_past={dropped_past}",
        flush=True,
    )
    ranked = [u for _, u in upcoming] + undated
    if MAX_DETAIL_PAGES > 0 and len(ranked) > MAX_DETAIL_PAGES:
        print(
            f"[darul_islah] capping detail fetch: {len(ranked)} -> {MAX_DETAIL_PAGES} "
            f"(DARUL_MAX_DETAIL_PAGES)",
            flush=True,
        )
        ranked = ranked[:MAX_DETAIL_PAGES]
    return ranked


def main() -> None:
    proxy_label = "direct"
    if _PROXIES:
        proxy_label = _redact_proxy(_PROXIES.get("https") or _PROXIES.get("http") or "")
    print(
        f"[darul_islah] START pid={os.getpid()} budget={MAX_RUNTIME_SECONDS}s "
        f"http_timeout={HTTP_TIMEOUT}s max_crawl={MAX_CRAWL_PAGES} "
        f"max_details={MAX_DETAIL_PAGES} via={proxy_label}",
        flush=True,
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pages, event_links, ics_links = discover_pages_and_links()
    print(
        f"[darul_islah] STAGE discover DONE pages_crawled={len(pages)} "
        f"event_links={len(event_links)} ics_links={len(ics_links)} elapsed={_elapsed()}s",
        flush=True,
    )

    ranked_links = filter_and_rank_event_links(event_links)
    print(
        f"[darul_islah] STAGE scrape_details n={len(ranked_links)} elapsed={_elapsed()}s",
        flush=True,
    )
    scraped: List[Dict] = []
    for i, u in enumerate(ranked_links, 1):
        if _out_of_budget("scrape_details"):
            break
        t0 = time.perf_counter()
        ev = parse_event_page(u)
        dt_ms = int((time.perf_counter() - t0) * 1000)
        if ev:
            scraped.append(ev)
        if i % 5 == 0 or i == len(ranked_links):
            print(
                f"[darul_islah] detail {i}/{len(ranked_links)} "
                f"kept={len(scraped)} last_ms={dt_ms} elapsed={_elapsed()}s",
                flush=True,
            )

    downloaded_ics_events: List[Dict] = []
    seen_ics_links = set()
    print(
        f"[darul_islah] STAGE ics candidates={len(LIVE_ICS_URLS) + len(ics_links)} "
        f"elapsed={_elapsed()}s",
        flush=True,
    )
    for link in LIVE_ICS_URLS + ics_links:
        if _out_of_budget("ics"):
            break
        if link in seen_ics_links:
            continue
        seen_ics_links.add(link)
        b = fetch_bytes(link, timeout=HTTP_TIMEOUT * 2, tries=HTTP_TRIES)
        if b and (b.startswith(b"BEGIN:VCALENDAR") or b"BEGIN:VCALENDAR" in b[:200]):
            DOWNLOADED_ICS.write_bytes(b)
            downloaded_ics_events.extend(parse_ics_file(DOWNLOADED_ICS))
            print(f"[darul_islah] downloaded_ics={link} events={len(downloaded_ics_events)}", flush=True)
            break

    local_ics_events: List[Dict] = []
    local_ics = newest_local_ics_file()
    if local_ics:
        local_ics_events = parse_ics_file(local_ics)
        print(f"[darul_islah] local_ics_file={local_ics} events={len(local_ics_events)}", flush=True)
    print(
        f"[darul_islah] STAGE merge local_ics={len(local_ics_events)} "
        f"downloaded_ics={len(downloaded_ics_events)} scraped={len(scraped)} "
        f"elapsed={_elapsed()}s",
        flush=True,
    )

    merged = dedupe(scraped + downloaded_ics_events + local_ics_events)
    OUT_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    blank_desc = sum(1 for e in merged if not e.get("description"))
    blank_date = sum(1 for e in merged if not e.get("date"))
    blank_start = sum(1 for e in merged if not e.get("start_time"))
    print(
        f"[darul_islah] DONE saved={OUT_JSON} total={len(merged)} "
        f"blank_desc={blank_desc} blank_date={blank_date} blank_start={blank_start} "
        f"elapsed={_elapsed()}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
