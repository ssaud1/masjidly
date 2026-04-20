#!/usr/bin/env python3
# Requirements:
#   pip install requests beautifulsoup4 lxml dateparser
#
# Usage:
#   .venv/bin/python enrich_all_masjids.py
#
# Output:
#   events_by_masjid/*_events.json (updated with speaker/details/posters where possible)
#   target_masjids_events.json
#   target_masjids_future_events.json

from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import dateparser
import requests
from bs4 import BeautifulSoup

from event_merge_utils import merge_fuzzy_duplicate_events

BASE_DIR = Path("/Users/shaheersaud/Safar")
EVENTS_DIR = BASE_DIR / "events_by_masjid"
TARGET_ALL = BASE_DIR / "target_masjids_events.json"
TARGET_FUTURE = BASE_DIR / "target_masjids_future_events.json"
TARGET_DETAILED = BASE_DIR / "target_masjids_future_events_detailed.json"
CACHE_DIR = EVENTS_DIR / "_cache"
HTTP_CACHE_META_FILE = CACHE_DIR / "http_meta.json"
OCR_HASH_CACHE_FILE = CACHE_DIR / "ocr_hash_cache.json"
ENRICH_STATE_FILE = CACHE_DIR / "enrich_state.json"

def list_masjid_event_files() -> List[Path]:
    """All per-masjid event JSON files (excluding underscore-prefixed reports)."""
    return sorted(
        p
        for p in EVENTS_DIR.glob("*_events.json")
        if p.is_file() and not p.name.startswith("_")
    )

TIMEOUT = 20
RETRIES = 2
MAX_WORKERS = 12
OCR_TIMEOUT = 12

RSVP_HOSTS = ("eventbrite.com", "forms.gle", "docs.google.com/forms", "jotform.com", "lu.ma", "partiful.com")
RSVP_TEXT = ("register", "rsvp", "sign up", "signup", "tickets", "ticket", "book now")
RSVP_BLOCKLIST = ("expense", "reimburse", "reimbursement", "invoice", "w-9", "tax", "payable")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")
JUNK_IMAGE = ("logo", "icon", "favicon", "avatar", "blank.gif", "pixel")

SPEAKER_RX = re.compile(
    r"\b(?:(?:shaykh|sheikh|imam|ustadh|mufti|dr\.?|qari)\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,3})",
    flags=re.I,
)
OCR_SPEAKER_RX = re.compile(
    r"\b(?:imam|shaykh|sheikh|ustadh|dr\.?|qari)\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,3}",
    flags=re.I,
)

OCR_HINT_WORDS = ("jum", "khut", "halaq", "lecture", "seminar", "program", "talk")
SPEAKER_BAD_SNIPPETS = (
    "job description",
    "imam corner",
    "contact us",
    "about us",
)
GENERIC_DESC_SNIPPETS = (
    "is a mosque, youth center and community center open to all",
    "about iceb purpose",
    "membership application",
    "top of page donate home about us",
    "darul islah was established in the 1970s",
)
_OCR_CACHE: Dict[str, str] = {}
_HTML_CACHE: Dict[str, Optional[str]] = {}
_HTTP_META: Dict[str, Dict[str, str]] = {}
_OCR_HASH_CACHE: Dict[str, str] = {}
_ENRICH_STATE: Dict[str, Dict[str, Dict]] = {}
INCREMENTAL_ENRICH = os.getenv("ENRICH_INCREMENTAL", "1") == "1"
DEEP_OCR = os.getenv("ENRICH_DEEP_OCR", "0") == "1"
POSTER_BACKFILL = os.getenv("ENRICH_POSTER_BACKFILL", "1") == "1"


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def sha1_text(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()


def sha1_bytes(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def load_json_dict(path: Path) -> Dict:
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def save_json_if_changed(path: Path, data) -> bool:
    serialized = json.dumps(data, indent=2, ensure_ascii=False)
    old = ""
    if path.exists():
        try:
            old = path.read_text(encoding="utf-8")
        except Exception:
            old = ""
    if old == serialized:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:10]}")
    try:
        tmp.write_text(serialized, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return True


def init_caches() -> None:
    global _HTTP_META, _OCR_HASH_CACHE, _ENRICH_STATE
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _HTTP_META = load_json_dict(HTTP_CACHE_META_FILE)
    _OCR_HASH_CACHE = load_json_dict(OCR_HASH_CACHE_FILE)
    _ENRICH_STATE = load_json_dict(ENRICH_STATE_FILE)


def save_caches() -> None:
    save_json_if_changed(HTTP_CACHE_META_FILE, _HTTP_META)
    save_json_if_changed(OCR_HASH_CACHE_FILE, _OCR_HASH_CACHE)
    save_json_if_changed(ENRICH_STATE_FILE, _ENRICH_STATE)


def fetch_html(url: str) -> Optional[str]:
    u = clean(url)
    if not u:
        return None
    if u in _HTML_CACHE:
        return _HTML_CACHE[u]
    headers = {"User-Agent": "Mozilla/5.0 (compatible; MasjidlyEnricher/1.0)"}
    meta = _HTTP_META.get(u, {})
    if meta.get("etag"):
        headers["If-None-Match"] = meta["etag"]
    if meta.get("last_modified"):
        headers["If-Modified-Since"] = meta["last_modified"]
    cache_file = CACHE_DIR / "http_bodies" / f"{sha1_text(u)}.html"
    for _ in range(RETRIES + 1):
        try:
            r = requests.get(u, timeout=TIMEOUT, headers=headers)
            ctype = (r.headers.get("Content-Type", "").lower())
            if r.status_code == 304 and cache_file.exists():
                _HTML_CACHE[u] = cache_file.read_text(encoding="utf-8", errors="ignore")
                return _HTML_CACHE[u]
            if r.status_code == 200 and "text/html" in ctype:
                body = r.text
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(body, encoding="utf-8")
                _HTTP_META[u] = {
                    "etag": clean(r.headers.get("ETag", "")),
                    "last_modified": clean(r.headers.get("Last-Modified", "")),
                    "cached_at": datetime.utcnow().isoformat(),
                }
                _HTML_CACHE[u] = body
                return _HTML_CACHE[u]
        except requests.RequestException:
            pass
    if cache_file.exists():
        _HTML_CACHE[u] = cache_file.read_text(encoding="utf-8", errors="ignore")
        return _HTML_CACHE[u]
    _HTML_CACHE[u] = None
    return None


def try_parse_json(s: str) -> Optional[object]:
    try:
        return json.loads(s)
    except Exception:
        return None


def normalize_image_urls(values: Iterable[object]) -> List[str]:
    out: List[str] = []

    def add_url(raw: str) -> None:
        u = clean(raw).replace("\\/", "/")
        if not u:
            return
        if u.startswith("//"):
            u = "https:" + u
        if not (u.startswith("http://") or u.startswith("https://")):
            return
        p = urlparse(u).path.lower()
        if p and not any(p.endswith(ext) for ext in IMAGE_EXTS) and "/media/" not in p and "/uploads/" not in p:
            return
        if any(j in p for j in JUNK_IMAGE):
            return
        if u not in out:
            out.append(u)

    def walk(v: object) -> None:
        if v is None:
            return
        if isinstance(v, list):
            for item in v:
                walk(item)
            return
        if isinstance(v, dict):
            for val in v.values():
                walk(val)
            return
        s = clean(str(v))
        if not s or s == "[]":
            return
        if s.startswith("[") or s.startswith("{"):
            parsed = try_parse_json(s)
            if parsed is not None:
                walk(parsed)
                return
        for m in re.finditer(r"https?://[^\s\"'<>]+", s):
            add_url(m.group(0))
        if s.startswith("http://") or s.startswith("https://") or s.startswith("//"):
            add_url(s)

    for x in values:
        walk(x)
    return out


def _title_keywords(title: str) -> List[str]:
    stop = {
        "the",
        "and",
        "with",
        "for",
        "from",
        "through",
        "post",
        "class",
        "classes",
        "program",
        "session",
        "event",
        "masjid",
    }
    toks = re.findall(r"[a-z0-9]+", clean(title).lower())
    out: List[str] = []
    for t in toks:
        if len(t) < 4:
            continue
        if t in stop:
            continue
        out.append(t)
    return out


def sanitize_event_images(event: Dict, images: List[str]) -> List[str]:
    source = clean(str(event.get("source", ""))).lower()
    title = clean(str(event.get("title", ""))).lower()
    if not images:
        return images

    # Global removals: non-poster platform/branding assets.
    global_block = (
        "facebook-negative",
        "instagram-negative",
        "youtube-negative",
        "tribe-loading",
        "tribe-related-events-placeholder",
        "footer-i",
        "/icons/",
        "/icon/",
    )
    cleaned = [u for u in images if not any(b in u.lower() for b in global_block)]
    if not cleaned:
        return []

    # Darul Islah pages often include unrelated weekly posters in event-page chrome.
    # Keep only images that appear semantically related to the event title.
    if source == "darul_islah":
        keys = _title_keywords(title)
        # For sensitive recurring rows, prefer blank over wrong poster.
        strict_titles = ("jummah", "di juniors")
        if keys and any(st in title for st in strict_titles):
            matched = []
            for u in cleaned:
                low = u.lower()
                if any(k in low for k in keys):
                    matched.append(u)
            return matched[:8]
    return cleaned[:8]


def extract_description(soup: BeautifulSoup) -> str:
    md = soup.find("meta", attrs={"name": "description"})
    og = soup.find("meta", attrs={"property": "og:description"})
    for v in (md.get("content", "") if md else "", og.get("content", "") if og else ""):
        t = clean(v)
        if len(t) > 40:
            return t
    for p in soup.find_all("p"):
        t = clean(p.get_text(" ", strip=True))
        if 70 <= len(t) <= 900:
            return t
    return ""


def extract_date_time(url: str, text: str) -> Tuple[str, str, str]:
    d = ""
    start = ""
    end = ""

    m = re.search(r"(20\d{2}-\d{2}-\d{2})", url)
    if m:
        d = m.group(1)

    if not d:
        for rx in (
            r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*20\d{2})?\b",
            r"\b\d{1,2}/\d{1,2}/20\d{2}\b",
            r"\b(?:mon|tue|wed|thu|fri|sat|sun)\,?\s+[A-Za-z]{3,9}\s+\d{1,2}\b",
        ):
            m2 = re.search(rx, text, flags=re.I)
            if not m2:
                continue
            parsed = dateparser.parse(m2.group(0), settings={"PREFER_DATES_FROM": "future"})
            if parsed:
                d = parsed.date().isoformat()
                break

    m3 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\s*[-–]\s*(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, flags=re.I)
    if m3:
        start, end = m3.group(1), m3.group(2)
    else:
        m4 = re.search(r"\b(\d{1,2}:\d{2}\s?(?:am|pm))\b", text, flags=re.I)
        if m4:
            start = m4.group(1)
    return d, start, end


def find_rsvp_link(soup: BeautifulSoup, base_url: str) -> str:
    best = ""
    best_score = -10
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href:
            continue
        txt = clean(a.get_text(" ", strip=True)).lower()
        full = urljoin(base_url, href)
        low = full.lower()
        combined = f"{txt} {low}"
        if any(b in combined for b in RSVP_BLOCKLIST):
            continue

        score = 0
        if any(h in low for h in RSVP_HOSTS):
            score += 2
        if any(t in txt for t in RSVP_TEXT):
            score += 4
        if any(t in low for t in ("register", "registration", "rsvp", "signup", "ticket")):
            score += 3

        if score > best_score:
            best = full
            best_score = score
    return best if best_score > 0 else ""


def collect_images(soup: BeautifulSoup, base_url: str, limit: int = 8) -> List[str]:
    values: List[object] = []
    for m in soup.find_all("meta"):
        prop = (m.get("property") or m.get("name") or "").lower()
        if prop in {"og:image", "twitter:image"}:
            values.append(m.get("content", ""))
    for img in soup.find_all("img"):
        values.append(img.get("src") or img.get("data-src") or img.get("data-lazy-src"))
    urls = normalize_image_urls(values)
    resolved: List[str] = []
    for u in urls:
        resolved_u = urljoin(base_url, u)
        if resolved_u not in resolved:
            resolved.append(resolved_u)
        if len(resolved) >= limit:
            break
    return resolved


def extract_speaker(event: Dict, soup: Optional[BeautifulSoup], body_text: str) -> str:
    # Keep existing if present.
    existing = clean(str(event.get("speaker", "")))
    if existing:
        return existing
    text = " ".join(
        [
            clean(str(event.get("title", ""))),
            clean(str(event.get("description", ""))),
            body_text,
        ]
    )
    m = SPEAKER_RX.search(text)
    if m:
        return clean(m.group(0))
    if soup:
        # Secondary signal: "Speaker: XYZ"
        full = clean(soup.get_text(" ", strip=True))
        m2 = re.search(r"\bSpeaker\s*:\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,4})", full)
        if m2:
            return clean(m2.group(1))
    return ""


def sanitize_speaker(value: str) -> str:
    s = clean(value)
    if not s:
        return ""
    low = s.lower()
    if any(bad in low for bad in SPEAKER_BAD_SNIPPETS):
        return ""
    # Keep speaker labels reasonably short and person-like.
    if len(s.split()) > 6:
        return ""
    return s


def should_try_ocr(event: Dict) -> bool:
    if DEEP_OCR and normalize_image_urls([event.get("image_urls", [])]):
        return True
    if clean(str(event.get("speaker", ""))):
        return False
    title_blob = clean(str(event.get("title", ""))).lower()
    if any(h in title_blob for h in OCR_HINT_WORDS):
        return True
    return False


def ocr_image_text(url: str) -> str:
    u = clean(url)
    if not u:
        return ""
    if u in _OCR_CACHE:
        return _OCR_CACHE[u]
    try:
        r = requests.get(u, timeout=TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200 or not r.content:
            _OCR_CACHE[u] = ""
            return ""
        image_hash = sha1_bytes(r.content)
        if image_hash in _OCR_HASH_CACHE:
            _OCR_CACHE[u] = clean(str(_OCR_HASH_CACHE.get(image_hash, "")))[:2000]
            return _OCR_CACHE[u]
        with tempfile.NamedTemporaryFile(suffix=".img", delete=True) as tmp:
            tmp.write(r.content)
            tmp.flush()
            proc = subprocess.run(
                ["tesseract", tmp.name, "stdout", "-l", "eng"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=OCR_TIMEOUT,
                check=False,
                text=True,
            )
            text = clean(proc.stdout or "")
            _OCR_CACHE[u] = text[:2000]
            _OCR_HASH_CACHE[image_hash] = _OCR_CACHE[u]
            return _OCR_CACHE[u]
    except Exception:
        _OCR_CACHE[u] = ""
        return ""


def enrich_one(event: Dict) -> Dict:
    e = dict(event)
    # Guarantee speaker field exists.
    e["speaker"] = clean(str(e.get("speaker", "")))

    url = clean(str(e.get("source_url", "")))
    if not url.startswith("http"):
        return e
    html = fetch_html(url)
    if not html:
        return e
    soup = BeautifulSoup(html, "lxml")
    body_text = clean(soup.get_text(" ", strip=True))

    # Title fill if missing.
    if not clean(str(e.get("title", ""))):
        h1 = soup.find("h1")
        if h1:
            e["title"] = clean(h1.get_text(" ", strip=True))

    # Description.
    desc = extract_description(soup)
    if desc and len(desc) > len(clean(str(e.get("description", "")))):
        e["description"] = desc

    # Date/time only fill missing.
    d, st, en = extract_date_time(url, body_text)
    if d and not clean(str(e.get("date", ""))):
        e["date"] = d
    if st and not clean(str(e.get("start_time", ""))):
        e["start_time"] = st
    if en and not clean(str(e.get("end_time", ""))):
        e["end_time"] = en

    # RSVP.
    rsvp = find_rsvp_link(soup, url)
    if rsvp and not clean(str(e.get("rsvp_link", ""))):
        e["rsvp_link"] = rsvp

    # Posters/images.
    imgs = collect_images(soup, url, limit=8)
    existing_imgs = normalize_image_urls([e.get("image_urls", [])])
    merged = []
    for x in existing_imgs + imgs:
        if x not in merged:
            merged.append(x)
    e["image_urls"] = merged

    # Speaker extraction.
    e["speaker"] = extract_speaker(e, soup, body_text)

    # Optional OCR from flyer/poster when speaker is missing.
    e["poster_ocr_text"] = clean(str(e.get("poster_ocr_text", "")))
    if should_try_ocr(e):
        imgs_for_ocr = e.get("image_urls", []) or []
        if imgs_for_ocr:
            ocr_text = ocr_image_text(str(imgs_for_ocr[0]))
            if ocr_text:
                e["poster_ocr_text"] = ocr_text
                if not e["speaker"]:
                    m_ocr = OCR_SPEAKER_RX.search(ocr_text)
                    if m_ocr:
                        e["speaker"] = clean(m_ocr.group(0))

    # Raw text refresh.
    if body_text:
        e["raw_text"] = body_text[:1800]

    # Confidence bump for newly-populated fields.
    score = float(e.get("confidence", 0.45) or 0.45)
    if clean(str(e.get("description", ""))):
        score += 0.05
    if clean(str(e.get("date", ""))):
        score += 0.06
    if clean(str(e.get("start_time", ""))):
        score += 0.04
    if e.get("image_urls"):
        score += 0.05
    if clean(str(e.get("speaker", ""))):
        score += 0.04
    e["confidence"] = min(1.0, round(score, 2))
    return e


def load_json(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: List[Dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:10]}")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def dedupe_events(events: List[Dict]) -> List[Dict]:
    seen = set()
    out: List[Dict] = []
    for e in events:
        key = (
            clean(str(e.get("source", ""))).lower(),
            clean(str(e.get("title", ""))).lower(),
            clean(str(e.get("date", ""))),
            clean(str(e.get("start_time", ""))).lower(),
            clean(str(e.get("source_url", ""))).lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or ""))
    return out


def infer_prayer_time_hint(event: Dict) -> str:
    text = " ".join(
        [
            clean(str(event.get("title", ""))),
            clean(str(event.get("description", ""))),
            clean(str(event.get("category", ""))),
            clean(str(event.get("audience", ""))),
        ]
    ).lower()
    if any(x in text for x in ("fajr", "suhoor", "sehri")):
        return "After Fajr"
    if any(x in text for x in ("jummah", "jumu", "khutbah", "dhuhr", "zuhr")):
        return "After Dhuhr"
    if any(x in text for x in ("asr", "afternoon")):
        return "After Asr"
    if any(x in text for x in ("iftar", "ramadan", "taraweeh", "maghrib")):
        return "After Maghrib"
    if any(x in text for x in ("qiyaam", "qiyam", "tahajjud", "isha", "night")):
        return "After Isha"
    return "After one of the daily prayers"


def build_fallback_description(event: Dict) -> str:
    title = clean(str(event.get("title", ""))) or "Community event"
    source = clean(str(event.get("source", ""))).upper() or "local masjid"
    location = clean(str(event.get("location_name", ""))) or clean(str(event.get("organizer", ""))) or "the masjid"
    date = clean(str(event.get("date", ""))) or "Date to be confirmed"
    start_time = clean(str(event.get("start_time", ""))) or infer_prayer_time_hint(event)
    audience = clean(str(event.get("audience", ""))).lower()
    title_blob = " ".join(
        [
            clean(str(event.get("title", ""))),
            clean(str(event.get("description", ""))),
            clean(str(event.get("category", ""))),
        ]
    ).lower()
    if not audience:
        if re.search(r"\b(sister|sisters|women|girls|female)\b", title_blob):
            audience = "sisters"
        elif re.search(r"\b(brother|brothers|men|boys|male)\b", title_blob):
            audience = "brothers"
        elif re.search(r"\b(family|families|parents|children|kids|youth)\b", title_blob):
            audience = "family"
    audience_text = {
        "brothers": "This session is intended for brothers.",
        "sisters": "This session is intended for sisters.",
        "family": "This program is suitable for families.",
        "youth": "This program is intended for youth attendees.",
    }.get(audience, "Community members are welcome to attend.")

    title_lower = title.lower()
    if any(x in title_lower for x in ("jummah", "khutbah")):
        focus = "A congregational prayer and reminder program."
    elif any(x in title_lower for x in ("halaqa", "khatira", "dars", "quran", "hadith")):
        focus = "An Islamic learning and reflection session."
    elif any(x in title_lower for x in ("workshop", "seminar", "prep", "class")):
        focus = "A focused educational session with practical takeaways."
    elif any(x in title_lower for x in ("fair", "bazaar", "fundraiser", "dinner")):
        focus = "A community gathering and engagement event."
    else:
        focus = "A community event hosted by the masjid."

    return (
        f"{title} is taking place at {location} ({source}) on {date} at {start_time}. "
        f"{focus} {audience_text} "
        "Please confirm final details on the official event page before attending."
    )


def normalize_event_fields(event: Dict) -> Dict:
    e = dict(event)
    # Ensure key fields always exist.
    e["source"] = clean(str(e.get("source", ""))).lower()
    e["title"] = clean(str(e.get("title", "")))
    e["location_name"] = clean(str(e.get("location_name", "")))
    e["organizer"] = clean(str(e.get("organizer", "")))
    e["date"] = clean(str(e.get("date", "")))
    e["start_time"] = clean(str(e.get("start_time", "")))
    e["end_time"] = clean(str(e.get("end_time", "")))

    desc = clean(str(e.get("description", "")))
    desc_lower = desc.lower()
    if (not desc) or (len(desc.split()) < 8) or any(snippet in desc_lower for snippet in GENERIC_DESC_SNIPPETS):
        e["description"] = build_fallback_description(e)
    else:
        e["description"] = desc

    if not e["start_time"]:
        e["start_time"] = infer_prayer_time_hint(e)

    e["image_urls"] = sanitize_event_images(e, normalize_image_urls([e.get("image_urls", [])]))
    e["speaker"] = sanitize_speaker(str(e.get("speaker", "")))
    return e


def event_identity_key(e: Dict) -> str:
    return "|".join(
        [
            clean(str(e.get("source", ""))).lower(),
            clean(str(e.get("title", ""))).lower(),
            clean(str(e.get("date", ""))),
            clean(str(e.get("start_time", ""))).lower(),
            clean(str(e.get("source_url", ""))).lower(),
        ]
    )


def event_input_hash(e: Dict) -> str:
    payload = {
        "source": clean(str(e.get("source", ""))),
        "source_type": clean(str(e.get("source_type", ""))),
        "source_url": clean(str(e.get("source_url", ""))),
        "title": clean(str(e.get("title", ""))),
        "description": clean(str(e.get("description", ""))),
        "date": clean(str(e.get("date", ""))),
        "start_time": clean(str(e.get("start_time", ""))),
        "end_time": clean(str(e.get("end_time", ""))),
        "location_name": clean(str(e.get("location_name", ""))),
        "address": clean(str(e.get("address", ""))),
        "image_urls": normalize_image_urls([e.get("image_urls", [])]),
        "speaker": clean(str(e.get("speaker", ""))),
    }
    return sha1_text(json.dumps(payload, sort_keys=True, ensure_ascii=False))


def enrich_file(path: Path) -> List[Dict]:
    data = [dict(x) for x in load_json(path)]
    if not data:
        return []
    # Ensure every row has speaker key before enrichment.
    for e in data:
        e["speaker"] = clean(str(e.get("speaker", "")))
        e["image_urls"] = normalize_image_urls([e.get("image_urls", [])])

    state_by_file = dict(_ENRICH_STATE.get(path.name, {}))
    to_enrich_idx: List[int] = []
    for i, e in enumerate(data):
        k = event_identity_key(e)
        h = event_input_hash(e)
        cached = state_by_file.get(k, {})
        needs_poster_backfill = (
            POSTER_BACKFILL
            and not normalize_image_urls([e.get("image_urls", [])])
            and clean(str(e.get("source_url", ""))).startswith("http")
        )
        if (
            INCREMENTAL_ENRICH
            and cached.get("input_hash") == h
            and isinstance(cached.get("event"), dict)
            and not needs_poster_backfill
        ):
            data[i] = dict(cached.get("event"))
        else:
            to_enrich_idx.append(i)

    print(f"{path.name}: incremental reused={len(data)-len(to_enrich_idx)} enrich={len(to_enrich_idx)}")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(enrich_one, data[i]): i for i in to_enrich_idx}
        done = 0
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                data[idx] = fut.result()
            except Exception:
                pass
            done += 1
            if done % 25 == 0:
                print(f"{path.name}: enriched {done}/{len(to_enrich_idx)}")
    # Normalize final fields so all events remain usable.
    data = [normalize_event_fields(e) for e in data]

    # Refresh state cache for this file.
    next_state: Dict[str, Dict] = {}
    for e in data:
        k = event_identity_key(e)
        next_state[k] = {
            "input_hash": event_input_hash(e),
            "event": e,
        }
    _ENRICH_STATE[path.name] = next_state
    out = dedupe_events(data)
    out = merge_fuzzy_duplicate_events(out)
    changed = save_json_if_changed(path, out)
    if not changed:
        print(f"{path.name}: unchanged write skipped")
    return out


def build_aggregate(all_events: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
    today = datetime.now().date().isoformat()

    # Non-regression safeguard: union new scrape with the prior aggregate so a failed
    # source (e.g., Instagram rate-limited for a day) never drops events we already had.
    # Prior entries are *appended* so freshly-enriched copies from the current scrape
    # win during dedupe (dedupe keeps the first occurrence of each identity key).
    keep_prior = os.getenv("ENRICH_PRESERVE_PRIOR", "1") == "1"
    prior_all: List[Dict] = []
    if keep_prior and TARGET_ALL.exists():
        try:
            prior_all = load_json(TARGET_ALL)
            if isinstance(prior_all, list):
                print(f"[preserve] unioning {len(prior_all)} prior aggregate events with {len(all_events)} fresh")
            else:
                prior_all = []
        except Exception as exc:
            print(f"[preserve] could not read prior {TARGET_ALL.name}: {exc}")
            prior_all = []
    combined = list(all_events) + list(prior_all)

    all_dedup = merge_fuzzy_duplicate_events(dedupe_events(combined))

    future: List[Dict] = []
    for e in all_dedup:
        d = clean(str(e.get("date", "")))
        if d and d >= today:
            future.append(e)
    future.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or ""))
    return all_dedup, future


def main() -> None:
    init_caches()
    refreshed: Dict[str, int] = {}
    all_events: List[Dict] = []
    file_workers = max(1, int(os.getenv("ENRICH_FILE_WORKERS", "2")))
    target_files = list_masjid_event_files()
    with ThreadPoolExecutor(max_workers=file_workers) as pool:
        futures = {pool.submit(enrich_file, p): p for p in target_files}
        for fut in as_completed(futures):
            p = futures[fut]
            events = fut.result()
            refreshed[p.name] = len(events)
            all_events.extend(events)
            print(f"{p.name}: saved {len(events)}")

    agg_all, agg_future = build_aggregate(all_events)
    if not save_json_if_changed(TARGET_ALL, agg_all):
        print(f"{TARGET_ALL.name}: unchanged write skipped")
    if not save_json_if_changed(TARGET_FUTURE, agg_future):
        print(f"{TARGET_FUTURE.name}: unchanged write skipped")
    if not save_json_if_changed(TARGET_DETAILED, agg_future):
        print(f"{TARGET_DETAILED.name}: unchanged write skipped")
    save_caches()

    print(f"aggregate_all={len(agg_all)} -> {TARGET_ALL}")
    print(f"aggregate_future={len(agg_future)} -> {TARGET_FUTURE}")
    print(f"future_detailed={len(agg_future)} -> {TARGET_DETAILED}")
    print("counts:", refreshed)


if __name__ == "__main__":
    main()
