#!/usr/bin/env python3
# Requirements:
#   pip install beautifulsoup4 dateparser
#
# Usage:
#   export GMAIL_USER="you@gmail.com"
#   export GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
#   .venv/bin/python ingest_masjid_emails.py
#
# Or put GMAIL_USER / GMAIL_APP_PASSWORD in Safar/.env (gitignored); the script loads it if unset.
#
# Discover newsletter senders not yet matched by rules (prints From lines to
# help you extend events_by_masjid/_email_sender_rules.json):
#   export EMAIL_DISCOVER_SENDERS=1
#   export EMAIL_DISCOVER_LOOKBACK_DAYS=30   # optional
#   .venv/bin/python ingest_masjid_emails.py
#
# Auto-merge inferred masjid rules into _email_sender_rules.json (needs IMAP):
#   export EMAIL_DISCOVER_WRITE_RULES=1
#   .venv/bin/python ingest_masjid_emails.py
#
# What it does:
# - Reads recent Gmail inbox emails via IMAP
# - Filters for configured masjid mailing sender patterns (defaults + optional
#   events_by_masjid/_email_sender_rules.json as a JSON list of [token, source])
# - Extracts event candidates (title/date/time/links/images) from email body
# - Merges results into events_by_masjid/<source>_events.json

from __future__ import annotations

import email
import hashlib
import imaplib
import json
from collections import defaultdict
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parseaddr
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import dateparser
from bs4 import BeautifulSoup

BASE = Path("/Users/shaheersaud/Safar")


def _load_local_env_file() -> None:
    """Load BASE/.env into os.environ if keys are not already set (never overrides real env)."""
    path = BASE / ".env"
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and val and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


_load_local_env_file()

EVENTS_DIR = BASE / "events_by_masjid"
POSTERS_DIR = EVENTS_DIR / "posters"
POSTERS_REVIEW_DIR = POSTERS_DIR / "_needs_review"
POSTER_OVERRIDE_FILE = EVENTS_DIR / "_poster_overrides.json"
STATE_FILE = EVENTS_DIR / "email_ingest_state.json"

GMAIL_HOST = "imap.gmail.com"
GMAIL_FOLDER = os.getenv("GMAIL_FOLDER", "INBOX")
LOOKBACK_DAYS = int(os.getenv("EMAIL_LOOKBACK_DAYS", "14"))
FORCE_REPROCESS = os.getenv("EMAIL_FORCE_REPROCESS", "0") == "1"
MAX_MESSAGES = int(os.getenv("EMAIL_MAX_MESSAGES", "200"))

# Sender substring (lowercase) -> source key matching events_by_masjid/<source>_events.json.
# More specific tokens must appear before broader ones.
DEFAULT_SENDER_SOURCE_RULES: List[Tuple[str, str]] = [
    ("info-mcmcnj.org@shared1.ccsend.com", "mcmc"),
    ("admin-iscj.org@shared1.ccsend.com", "iscj"),
    ("admin@themuslimcenter.org", "mcgp"),
    ("gmail.mcsv.net", "mcgp"),
    ("@themuslimcenter.org", "mcgp"),
    ("themuslimcenter.org", "mcgp"),
    ("@mcmcnj.org", "mcmc"),
    ("mcmcnj.org", "mcmc"),
    ("@iscj.org", "iscj"),
    ("iscj.org", "iscj"),
    ("@icpcnj.org", "icpc"),
    ("icpcnj.org", "icpc"),
    ("@nbic.org", "nbic"),
    ("nbic.org", "nbic"),
    ("@iceb.nj", "iceb"),
    ("iceb.nj", "iceb"),
    ("@icsjmasjid.org", "icsj"),
    ("icsjmasjid.org", "icsj"),
    ("@islamiccenterofsouthjersey.org", "icsj"),
    ("islamiccenterofsouthjersey.org", "icsj"),
    ("masjid.icsj@gmail.com", "icsj"),
    ("@alfalahcenter.org", "alfalah"),
    ("alfalahcenter.org", "alfalah"),
    ("@darulislah.org", "darul_islah"),
    ("darulislah.org", "darul_islah"),
    ("@masjidalwali.org", "masjid_al_wali"),
    ("masjidalwali.org", "masjid_al_wali"),
    ("@masjidmuhammadnewark.org", "masjid_muhammad_newark"),
    ("masjidmuhammadnewark.org", "masjid_muhammad_newark"),
    ("@icucnj.com", "icuc"),
    ("icucnj.com", "icuc"),
    ("@ismcnj.org", "ismc"),
    ("ismcnj.org", "ismc"),
    ("@mcnjonline.com", "mcnj"),
    ("mcnjonline.com", "mcnj"),
    ("@icnanj.org", "icna_nj"),
    ("icnanj.org", "icna_nj"),
    ("@jmic.org", "jmic"),
    ("jmic.org", "jmic"),
    ("@icmcnj.com", "icmc"),
    ("icmcnj.com", "icmc"),
    ("@icoconline.org", "icoc"),
    ("icoconline.org", "icoc"),
    ("@bayonnemasjid.com", "bayonne_mc"),
    ("bayonnemasjid.com", "bayonne_mc"),
    ("@hudsonislamic.org", "hudson_ic"),
    ("hudsonislamic.org", "hudson_ic"),
    ("@isbcnj.org", "isbc"),
    ("isbcnj.org", "isbc"),
    ("@muslimcenterjc.org", "mcjc"),
    ("muslimcenterjc.org", "mcjc"),
    ("masjidwaarith", "waarith"),
    ("waarithudd", "waarith"),
]

EMAIL_SENDER_RULES_FILE = EVENTS_DIR / "_email_sender_rules.json"
NJ_MASJID_MANIFEST = EVENTS_DIR / "_nj_masjid_manifest.json"
_MERGED_SENDER_RULES: Optional[List[Tuple[str, str]]] = None

# Consumer / ESP hosts: never infer a masjid source from these address domains alone.
_GENERIC_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "ymail.com",
        "hotmail.com",
        "outlook.com",
        "live.com",
        "msn.com",
        "icloud.com",
        "me.com",
        "mac.com",
        "aol.com",
        "proton.me",
        "protonmail.com",
    }
)
# Skip generic social hosts when mining domains from the manifest.
def _is_skipped_social_manifest_host(host: str) -> bool:
    h = (host or "").lower()
    for suf in (
        "instagram.com",
        "facebook.com",
        "youtube.com",
        "twitter.com",
        "tiktok.com",
        "x.com",
    ):
        if h == suf or h.endswith("." + suf):
            return True
    return False


def get_sender_source_rules() -> List[Tuple[str, str]]:
    """
    Prepend pairs from events_by_masjid/_email_sender_rules.json when present:
    [["noreply@example.org", "icpc"], ...]
    """
    global _MERGED_SENDER_RULES
    if _MERGED_SENDER_RULES is not None:
        return _MERGED_SENDER_RULES
    prepend: List[Tuple[str, str]] = []
    if EMAIL_SENDER_RULES_FILE.exists():
        try:
            raw = json.loads(EMAIL_SENDER_RULES_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for row in raw:
                    if isinstance(row, (list, tuple)) and len(row) >= 2:
                        tok = clean(str(row[0])).lower()
                        src = clean(str(row[1])).lower()
                        if tok and src:
                            prepend.append((tok, src))
        except Exception:
            pass
    _MERGED_SENDER_RULES = prepend + DEFAULT_SENDER_SOURCE_RULES
    return _MERGED_SENDER_RULES

SOURCE_META: Dict[str, Dict[str, str]] = {
    "mcgp": {
        "organizer": "Muslim Center of Greater Princeton",
        "location_name": "Muslim Center of Greater Princeton",
        "address": "2030 Old Trenton Rd, West Windsor Township, NJ 08550",
        "city": "West Windsor Township",
        "state": "NJ",
        "zip": "08550",
    },
    "mcmc": {
        "organizer": "Muslim Center of Middlesex County",
        "location_name": "Muslim Center of Middlesex County",
        "address": "1000 Hoes Ln, Piscataway, NJ 08854",
        "city": "Piscataway",
        "state": "NJ",
        "zip": "08854",
    },
    "iscj": {
        "organizer": "Islamic Society of Central Jersey",
        "location_name": "Islamic Society of Central Jersey",
        "address": "4145 US-1, Monmouth Junction, NJ 08852",
        "city": "Monmouth Junction",
        "state": "NJ",
        "zip": "08852",
    },
    "icpc": {
        "organizer": "Islamic Center of Passaic County",
        "location_name": "Islamic Center of Passaic County",
        "address": "152 Derrom Ave, Paterson, NJ 07504",
        "city": "Paterson",
        "state": "NJ",
        "zip": "07504",
    },
    "iceb": {
        "organizer": "Islamic Center of East Brunswick",
        "location_name": "Islamic Center of East Brunswick",
        "address": "402 New Brunswick Ave, East Brunswick, NJ 08816",
        "city": "East Brunswick",
        "state": "NJ",
        "zip": "08816",
    },
    "nbic": {
        "organizer": "New Brunswick Islamic Center",
        "location_name": "New Brunswick Islamic Center",
        "address": "1330 Livingston Ave Unit 4, North Brunswick, NJ 08902",
        "city": "North Brunswick",
        "state": "NJ",
        "zip": "08902",
    },
    "alfalah": {
        "organizer": "Al Falah Center",
        "location_name": "Al Falah Center",
        "address": "15 Grove St, Somerset, NJ 08873",
        "city": "Somerset",
        "state": "NJ",
        "zip": "08873",
    },
    "darul_islah": {
        "organizer": "Darul Islah",
        "location_name": "Darul Islah",
        "address": "202-206 James St, Teaneck, NJ 07666",
        "city": "Teaneck",
        "state": "NJ",
        "zip": "07666",
    },
    "masjid_al_wali": {
        "organizer": "Masjid Al-Wali",
        "location_name": "Masjid Al-Wali",
        "address": "421 New Dover Rd, Edison, NJ 08820",
        "city": "Edison",
        "state": "NJ",
        "zip": "08820",
    },
    "icsj": {
        "organizer": "Islamic Center of South Jersey",
        "location_name": "Islamic Center of South Jersey",
        "address": "4145 Evesham Rd, Voorhees Township, NJ 08043",
        "city": "Voorhees Township",
        "state": "NJ",
        "zip": "08043",
    },
    "masjid_muhammad_newark": {
        "organizer": "Masjid Muhammad Newark",
        "location_name": "Masjid Muhammad Newark",
        "address": "257 S Orange Ave, Newark, NJ 07103",
        "city": "Newark",
        "state": "NJ",
        "zip": "07103",
    },
    "icuc": {
        "organizer": "Islamic Center of Union County",
        "location_name": "Islamic Center of Union County",
        "address": "2372 Morris Ave, Union, NJ 07083",
        "city": "Union",
        "state": "NJ",
        "zip": "07083",
    },
    "ismc": {
        "organizer": "Islamic Society of Monmouth County",
        "location_name": "Masjid Al-Aman (ISMCNJ)",
        "address": "496 Red Hill Rd, Middletown, NJ 07748",
        "city": "Middletown",
        "state": "NJ",
        "zip": "07748",
    },
    "mcnj": {
        "organizer": "Muslim Community of New Jersey",
        "location_name": "MCNJ Masjid",
        "address": "15 S 2nd St, Fords, NJ 08863",
        "city": "Fords",
        "state": "NJ",
        "zip": "08863",
    },
    "icna_nj": {
        "organizer": "ICNA New Jersey",
        "location_name": "ICNA New Jersey",
        "address": "1320 Hamilton St, Somerset, NJ 08873",
        "city": "Somerset",
        "state": "NJ",
        "zip": "08873",
    },
    "jmic": {
        "organizer": "Jam-e-Masjid Islamic Center",
        "location_name": "Jam-e-Masjid Islamic Center",
        "address": "110 Harrison St, Boonton, NJ 07005",
        "city": "Boonton",
        "state": "NJ",
        "zip": "07005",
    },
    "icmc": {
        "organizer": "Islamic Center of Morris County",
        "location_name": "Islamic Center of Morris County",
        "address": "1 Mannino Dr, Rockaway, NJ 07866",
        "city": "Rockaway",
        "state": "NJ",
        "zip": "07866",
    },
    "icoc": {
        "organizer": "Islamic Center of Ocean County",
        "location_name": "Islamic Center of Ocean County (Masjid Al-Mustafa)",
        "address": "2116 Whitesville Rd, Toms River, NJ 08755",
        "city": "Toms River",
        "state": "NJ",
        "zip": "08755",
    },
    "bayonne_mc": {
        "organizer": "Bayonne Muslims Community Center",
        "location_name": "Bayonne Muslims Masjid",
        "address": "109 E 24th St, Bayonne, NJ 07002",
        "city": "Bayonne",
        "state": "NJ",
        "zip": "07002",
    },
    "hudson_ic": {
        "organizer": "Hudson Islamic Center",
        "location_name": "Hudson Islamic Center",
        "address": "1 Bergen Ave, Jersey City, NJ 07305",
        "city": "Jersey City",
        "state": "NJ",
        "zip": "07305",
    },
    "clifton_ic": {
        "organizer": "Islamic Center of Clifton",
        "location_name": "Islamic Center of Clifton",
        "address": "124 Malone Ave, Clifton, NJ 07011",
        "city": "Clifton",
        "state": "NJ",
        "zip": "07011",
    },
    "isbc": {
        "organizer": "Islamic Society of Basking Ridge",
        "location_name": "Islamic Society of Basking Ridge",
        "address": "100 S Finley Ave, Basking Ridge, NJ 07920",
        "city": "Basking Ridge",
        "state": "NJ",
        "zip": "07920",
    },
    "mcjc": {
        "organizer": "Muslim Center of Jersey City",
        "location_name": "Muslim Center of Jersey City",
        "address": "47 Belmont Ave, Jersey City, NJ 07304",
        "city": "Jersey City",
        "state": "NJ",
        "zip": "07304",
    },
    "waarith": {
        "organizer": "Masjid Waarith ud Deen",
        "location_name": "Masjid Waarith ud Deen",
        "address": "4 Gifford Ln, Newark, NJ 07106",
        "city": "Newark",
        "state": "NJ",
        "zip": "07106",
    },
}

TIME_RANGE_RX = re.compile(
    r"\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b",
    flags=re.I,
)
TIME_SINGLE_RX = re.compile(r"\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b", flags=re.I)
DATE_RX = re.compile(
    r"\b(?:mon|tue|wed|thu|fri|sat|sun)?\.?,?\s*"
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*20\d{2})?\b",
    flags=re.I,
)
MMDD_RX = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
RSVP_HINTS = ("register", "rsvp", "sign up", "signup", "ticket", "eventbrite", "forms.gle")
BAD_IMAGE_HINTS = ("logo", "icon", "favicon", "facebook-negative", "instagram-negative", "youtube-negative")
EVENT_SECTION_HINTS = (
    "program",
    "event",
    "halaqa",
    "khatira",
    "tafsir",
    "workshop",
    "lecture",
    "class",
    "night",
    "gathering",
    "prep",
    "mommy",
    "family",
    "dhikr",
    "jumu",
)
NON_EVENT_SECTION_HINTS = (
    "quran ayat",
    "prayer timing",
    "survey",
    "services",
    "regular events at the muslim center",
    "regular events at muslim center",
    "view this email in your browser",
    "contents",
    "latest info -",
)
POSTER_EVENT_HINTS = (
    "jumu",
    "halaqa",
    "program",
    "event",
    "workshop",
    "lecture",
    "tafsir",
    "dhikr",
    "family",
    "sisters",
    "brothers",
    "youth",
    "eid",
    "ramadan",
    "breakfast",
    "hajj",
    "seminar",
    "taekwondo",
    "soccer",
    "academy",
    "prophetic",
    "workout",
    "icky",
    "cozy",
)
MCGP_EVENT_ALLOW_HINTS = (
    "mommy",
    "prep",
    "tafsir",
    "contentment",
    "dhikr",
    "voter registration",
    "schedule",
    "jumu",
    "family",
    "class",
    "workshop",
    "lecture",
    "program",
    "khatira",
)
MCMC_EVENT_ALLOW_HINTS = (
    "jumu",
    "halaqa",
    "workshop",
    "lecture",
    "class",
    "program",
    "special needs",
    "family",
    "youth",
    "sisters",
    "brothers",
    "eid",
    "iftar",
    "breakfast",
    "hajj",
    "soccer",
    "academy",
    "prophetic",
    "path",
    "taekwondo",
    "icky",
    "cozy",
    "workout",
)
MCMC_NON_EVENT_HINTS = (
    "program director",
    "date:",
    "from:",
    "subject:",
    "to:",
    "forwarded message",
)
MCMC_POSTER_TITLE_PATTERNS: List[Tuple[str, str]] = [
    ("breakfast club", "Breakfast Club"),
    ("from icky to cozy", "From Icky to Cozy"),
    ("hajj seminar", "Hajj Seminar"),
    ("taekwondo", "Taekwondo Classes"),
    ("sisters workout", "Sisters Workout Class"),
    ("soccer academy", "Soccer Academy"),
    ("prophetic path", "Prophetic Path"),
]


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def normalize_title(title: str) -> str:
    t = clean(title)
    # Strip numbering/bullets/markdown-ish prefixes often found in newsletters.
    t = re.sub(r"^[\-\*\•\.\)\( ]+", "", t)
    t = re.sub(r"^\d+\s*[\.\)\-:]+\s*", "", t)
    t = re.sub(r"^\*\*+\s*", "", t)
    t = clean(t)
    return t


def title_key(title: str) -> str:
    t = normalize_title(title).lower()
    # Remove punctuation noise for matching across contents/body variants.
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return clean(t)


def merge_title_key(title: str) -> str:
    """
    Canonical key for cross-variant title collapsing.
    """
    t = normalize_title(title).lower()
    # Remove leading emoji-like symbols and bullets.
    t = re.sub(r"^[^\w]+", "", t)
    # Drop parenthetical schedule/date suffixes.
    t = re.sub(r"\((?:starts|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[^)]*\)", "", t, flags=re.I)
    # Normalize known banner prefixes.
    t = t.replace("conversing with the divine:", "")
    t = t.replace("weekend schedule for", "")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return clean(t)


def is_noise_title(title: str) -> bool:
    t = normalize_title(title)
    low = t.lower()
    if len(t) < 6 or len(t) > 180:
        return True
    if len(t.split()) > 14:
        return True
    if any(h in low for h in NON_EVENT_SECTION_HINTS):
        return True
    if re.match(r"^a+ss?alaam", low):
        return True
    if "may allah continue" in low:
        return True
    if "take the survey" in low:
        return True
    if "registration cutoff" in low or "vbm application cutoff" in low:
        return True
    if low.startswith("questions?"):
        return True
    if low.startswith("http://") or low.startswith("https://"):
        return True
    if "mcgp.link/" in low and len(low.split()) < 5:
        return True
    if "limited seats available" in low or "registration limited" in low:
        return True
    if re.search(r"\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b.*\d{1,2}/\d{1,2}", low):
        return True
    if re.match(r"^[\W_]*[\d: ]+(am|pm)\b", low):
        return True
    if "jumuah khutbah" in low and len(low.split()) <= 6:
        return True
    if re.fullmatch(r"[-_=]{4,}", t):
        return True
    return False


def title_quality_score(title: str) -> int:
    t = normalize_title(title)
    low = t.lower()
    score = 0
    if is_noise_title(t):
        return -10
    if any(k in low for k in EVENT_SECTION_HINTS):
        score += 2
    if re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}/\d{1,2})\b", low):
        score += 2
    if re.search(r"\b(am|pm)\b", low):
        score += 1
    if "news & happening" in low:
        score -= 2
    if len(t.split()) <= 2:
        score -= 1
    return score


def event_like_for_source(source: str, title: str, text: str) -> bool:
    low_title = normalize_title(title).lower()
    low_text = clean(text).lower()
    has_date_or_time = bool(
        DATE_RX.search(low_text)
        or MMDD_RX.search(low_text)
        or TIME_SINGLE_RX.search(low_text)
        or re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec)\b", low_text)
    )
    if source == "mcgp":
        has_allow = any(k in low_title or k in low_text for k in MCGP_EVENT_ALLOW_HINTS)
        has_explicit_time = bool(TIME_SINGLE_RX.search(low_text))
        if "news & happening" in low_title and not has_explicit_time:
            return False
        return has_allow and has_date_or_time and title_quality_score(title) >= 1
    if source == "mcmc":
        if any(h in low_title for h in MCMC_NON_EVENT_HINTS):
            return False
        has_allow = any(k in low_title or k in low_text for k in MCMC_EVENT_ALLOW_HINTS)
        has_recurring_hint = bool(
            re.search(r"\b(mon|tues|wednes|thurs|fri|satur|sun)day\b", low_text)
            or "weekly" in low_text
            or "every " in low_text
        )
        known_program = any(v.lower() in low_title for _, v in MCMC_POSTER_TITLE_PATTERNS)
        return has_allow and (has_date_or_time or has_recurring_hint or known_program) and title_quality_score(title) >= -1
    # generic rule for other senders
    return (title_quality_score(title) >= 1) and has_date_or_time


def decode_mime_text(raw: Optional[str]) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out = []
    for value, enc in parts:
        if isinstance(value, bytes):
            out.append(value.decode(enc or "utf-8", errors="ignore"))
        else:
            out.append(value)
    return clean("".join(out))


def load_json(path: Path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_state() -> Dict[str, List[str]]:
    state = {"processed_message_ids": []}
    if STATE_FILE.exists():
        try:
            parsed = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                state.update(parsed)
        except Exception:
            pass
    if not isinstance(state.get("processed_message_ids"), list):
        state["processed_message_ids"] = []
    return state


def save_state(state: Dict[str, List[str]]) -> None:
    save_json(STATE_FILE, state)


def detect_source(sender_header: str) -> Optional[str]:
    sender_low = clean(sender_header).lower()
    for token, src in get_sender_source_rules():
        if token in sender_low:
            return src
    return None


def detect_source_from_content(subject: str, text_body: str, html_body: str) -> Optional[str]:
    """
    Fallback source detection for forwarded emails where sender is the user.
    """
    blob = clean(" ".join([subject, text_body, html_body])).lower()
    for token, src in get_sender_source_rules():
        if token in blob:
            return src
    # Common forwarded header patterns.
    for token, src in get_sender_source_rules():
        if f"from:{token}" in blob or f"from: {token}" in blob:
            return src
    return None


def _token_to_domain(tok: str) -> Optional[str]:
    t = clean(tok).lower()
    if not t or " " in t:
        return None
    if "@" in t:
        part = t.split("@", 1)[-1]
    else:
        part = t
    if re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", part):
        return part
    return None


def _domain_to_source_from_defaults() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for tok, src in DEFAULT_SENDER_SOURCE_RULES:
        d = _token_to_domain(tok)
        if d and d not in _GENERIC_EMAIL_DOMAINS:
            out[d] = src
    return out


def _domain_to_source_from_manifest() -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not NJ_MASJID_MANIFEST.exists():
        return out
    try:
        data = json.loads(NJ_MASJID_MANIFEST.read_text(encoding="utf-8"))
    except Exception:
        return out
    for m in data.get("masjids") or []:
        if not isinstance(m, dict):
            continue
        src = clean(str(m.get("source", ""))).lower()
        if not src:
            continue
        for key in ("website", "events_url", "instagram"):
            raw = clean(str(m.get(key, "")))
            if not raw.startswith("http"):
                continue
            try:
                host = (urlparse(raw).hostname or "").lower()
            except Exception:
                continue
            if not host or _is_skipped_social_manifest_host(host):
                continue
            if host in _GENERIC_EMAIL_DOMAINS:
                continue
            if host.startswith("www."):
                out[host] = src
                out[host[4:]] = src
            else:
                out[host] = src
                out[f"www.{host}"] = src
    return out


_RANKED_DOMAIN_SOURCE_CACHE: Optional[List[Tuple[str, str]]] = None


def build_ranked_domain_source_pairs() -> List[Tuple[str, str]]:
    global _RANKED_DOMAIN_SOURCE_CACHE
    if _RANKED_DOMAIN_SOURCE_CACHE is not None:
        return _RANKED_DOMAIN_SOURCE_CACHE
    merged: Dict[str, str] = {}
    merged.update(_domain_to_source_from_defaults())
    merged.update(_domain_to_source_from_manifest())
    _RANKED_DOMAIN_SOURCE_CACHE = sorted(merged.items(), key=lambda kv: len(kv[0]), reverse=True)
    return _RANKED_DOMAIN_SOURCE_CACHE


def _candidate_host_suffixes(host: str) -> List[str]:
    parts = (host or "").lower().strip(".").split(".")
    if len(parts) < 2:
        return []
    out: List[str] = []
    for i in range(0, len(parts) - 1):
        seg = ".".join(parts[i:])
        if seg.count(".") >= 1:
            out.append(seg)
    return sorted(set(out), key=len, reverse=True)


def infer_masjid_source_from_blob(blob: str) -> Optional[Tuple[str, str]]:
    """
    If blob contains a known masjid domain (in text or inside URL hosts), return
    (matched_domain, source). Longest registered domain wins.
    """
    low = clean(blob).lower()
    if not low:
        return None
    dmap = dict(build_ranked_domain_source_pairs())
    for m in re.finditer(r"https?://([^/\s?#\"'<>]+)", low):
        host = m.group(1).lower().split("@", 1)[-1]
        if host.startswith("www."):
            host = host[4:]
        for suf in _candidate_host_suffixes(host):
            if suf in dmap:
                return suf, dmap[suf]
    ranked = sorted(dmap.items(), key=lambda kv: len(kv[0]), reverse=True)
    for dom, src in ranked:
        if dom in low:
            return dom, src
    return None


def _header_and_snippet_blob(msg: email.message.Message, text_body: str, html_body: str) -> str:
    parts: List[str] = []
    for key in ("From", "Return-Path", "Reply-To", "Sender", "List-Unsubscribe", "List-Id", "Subject"):
        parts.append(decode_mime_text(msg.get(key, "")))
    snippet = clean((text_body or "") + " " + (html_body or ""))[:12000]
    return clean(" ".join(parts) + " " + snippet).lower()


def _load_existing_sender_rules_rows() -> List[List[str]]:
    if not EMAIL_SENDER_RULES_FILE.exists():
        return []
    try:
        raw = json.loads(EMAIL_SENDER_RULES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    out: List[List[str]] = []
    if isinstance(raw, list):
        for row in raw:
            if isinstance(row, (list, tuple)) and len(row) >= 2:
                a, b = clean(str(row[0])), clean(str(row[1])).lower()
                if a and b:
                    out.append([a, b])
    return out


def _dedupe_rules(rows: List[List[str]]) -> List[List[str]]:
    seen: set = set()
    out: List[List[str]] = []
    for r in rows:
        if len(r) < 2:
            continue
        k = r[0].strip().lower()
        if k in seen:
            continue
        seen.add(k)
        out.append([r[0].strip(), r[1].strip().lower()])
    return out


def _known_rule_tokens_for_dedupe() -> set:
    s = {t.lower() for t, _ in DEFAULT_SENDER_SOURCE_RULES}
    for row in _load_existing_sender_rules_rows():
        s.add(row[0].lower())
    return s


def _propose_rule_token(sender: str, matched_domain: str, src: str) -> Optional[str]:
    _, addr = parseaddr(sender)
    addr = addr.strip().lower()
    if addr and "@" in addr:
        dom = addr.rsplit("@", 1)[-1]
        if dom in _GENERIC_EMAIL_DOMAINS:
            return f"@{matched_domain}"
        relay = ("mailchimp" in dom) or ("list-manage" in dom) or ("ccsend" in dom) or ("constantcontact" in dom)
        if relay or matched_domain in dom or dom.endswith("." + matched_domain) or dom == matched_domain:
            return addr
    return f"@{matched_domain}"


def sync_email_sender_rules_from_gmail() -> None:
    """
    Scan recent inbox, infer masjid source from known org domains in headers/body,
    append new [token, source] rows to _email_sender_rules.json (deduped).
    """
    global _MERGED_SENDER_RULES, _RANKED_DOMAIN_SOURCE_CACHE
    user = clean(os.getenv("GMAIL_USER", ""))
    password = clean(os.getenv("GMAIL_APP_PASSWORD", ""))
    if not user or not password:
        raise SystemExit("Missing GMAIL_USER or GMAIL_APP_PASSWORD env var.")

    lookback = int(os.getenv("EMAIL_DISCOVER_LOOKBACK_DAYS", str(LOOKBACK_DAYS)))
    max_n = int(os.getenv("EMAIL_DISCOVER_MAX_MESSAGES", "800"))
    since = (datetime.utcnow() - timedelta(days=lookback)).strftime("%d-%b-%Y")

    known = _known_rule_tokens_for_dedupe()
    proposed: List[List[str]] = []
    scanned = 0
    inferred_ct = 0

    imap = imaplib.IMAP4_SSL(GMAIL_HOST)
    try:
        imap.login(user, password)
        imap.select(GMAIL_FOLDER)
        typ, data = imap.search(None, "SINCE", since)
        if typ != "OK":
            raise RuntimeError("IMAP search failed")
        ids = data[0].split()[-max_n:]
        for mid in ids:
            typ2, msg_data = imap.fetch(mid, "(RFC822)")
            if typ2 != "OK" or not msg_data or not msg_data[0]:
                continue
            scanned += 1
            raw_bytes = msg_data[0][1]
            msg = email.message_from_bytes(raw_bytes)
            sender = decode_mime_text(msg.get("From", ""))
            subject = decode_mime_text(msg.get("Subject", ""))
            text_body, html_body = parse_message_bodies(msg)
            mapped = detect_source(sender) or detect_source_from_content(subject, text_body, html_body)
            if mapped:
                continue
            blob = _header_and_snippet_blob(msg, text_body, html_body)
            hit = infer_masjid_source_from_blob(blob)
            if not hit:
                continue
            matched_domain, src = hit
            token = _propose_rule_token(sender, matched_domain, src)
            if not token:
                continue
            tl = token.lower()
            if tl in known:
                continue
            known.add(tl)
            proposed.append([token, src])
            inferred_ct += 1
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    if not proposed:
        print(
            f"sync_rules: scanned={scanned} new_rules=0 (nothing unmapped matched a known masjid domain; "
            f"try EMAIL_DISCOVER_SENDERS=1 and add rules by hand)"
        )
        return

    existing = _load_existing_sender_rules_rows()
    merged = _dedupe_rules(proposed + existing)
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    EMAIL_SENDER_RULES_FILE.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    _MERGED_SENDER_RULES = None
    _RANKED_DOMAIN_SOURCE_CACHE = None
    print(f"sync_rules: scanned={scanned} new_rules={inferred_ct} saved={EMAIL_SENDER_RULES_FILE} total_rows={len(merged)}")


def parse_message_bodies(msg: email.message.Message) -> Tuple[str, str]:
    text_parts: List[str] = []
    html_parts: List[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = (part.get_content_type() or "").lower()
            disp = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="ignore")
            if ctype == "text/plain":
                text_parts.append(decoded)
            elif ctype == "text/html":
                html_parts.append(decoded)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            ctype = (msg.get_content_type() or "").lower()
            charset = msg.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="ignore")
            if ctype == "text/html":
                html_parts.append(decoded)
            else:
                text_parts.append(decoded)
    # Keep line breaks for section parsing (contents blocks/headings).
    text_blob = "\n".join(text_parts).replace("\r\n", "\n").replace("\r", "\n").strip()
    html_blob = "\n".join(html_parts)
    return text_blob, html_blob


def extract_links_images_from_html(html: str) -> Tuple[List[str], List[str], str]:
    if not html:
        return [], [], ""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style"]):
        tag.extract()
    links: List[str] = []
    images: List[str] = []
    for a in soup.find_all("a", href=True):
        u = clean(a["href"])
        if u.startswith("http") and u not in links:
            links.append(u)
    for img in soup.find_all("img", src=True):
        u = clean(img["src"])
        if not u.startswith("http"):
            continue
        low = u.lower()
        if any(h in low for h in BAD_IMAGE_HINTS):
            continue
        if u not in images:
            images.append(u)
    text = clean(soup.get_text(" ", strip=True))
    return links, images, text


def parse_sections_from_html(html: str) -> List[Dict[str, str]]:
    """
    Parse newsletter-like sections from HTML.
    Uses heading-ish tags and nearby text as event blocks.
    """
    if not html:
        return []
    soup = BeautifulSoup(html, "lxml")
    sections: List[Dict[str, str]] = []
    # typical email heading tags
    heading_tags = soup.find_all(["h1", "h2", "h3", "h4", "strong", "b"])
    seen_titles = set()
    for h in heading_tags:
        title = normalize_title(h.get_text(" ", strip=True))
        if is_noise_title(title):
            continue
        low_title = title_key(title)
        if low_title in seen_titles:
            continue
        if not any(x in low_title for x in EVENT_SECTION_HINTS) and not re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}/\d{1,2})\b", low_title):
            continue
        # gather nearby paragraph-like siblings
        snippets = [title]
        sib = h
        steps = 0
        while sib and steps < 6:
            sib = sib.find_next_sibling()
            if sib is None:
                break
            txt = clean(sib.get_text(" ", strip=True))
            if not txt:
                steps += 1
                continue
            if len(txt) > 500:
                txt = txt[:500]
            snippets.append(txt)
            if re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}/\d{1,2}|am|pm)\b", txt.lower()):
                # enough context
                if len(snippets) >= 3:
                    break
            steps += 1
        block_text = clean(" ".join(snippets))
        if len(block_text) < 30:
            continue
        # image near heading
        img_url = ""
        section_links: List[str] = []
        for a in h.find_all_next("a", href=True, limit=10):
            u = clean(a["href"])
            if u.startswith("http") and u not in section_links:
                section_links.append(u)
        nearby_img = h.find_next("img")
        if nearby_img and nearby_img.get("src"):
            cand = clean(nearby_img.get("src"))
            if cand.startswith("http") and not any(k in cand.lower() for k in BAD_IMAGE_HINTS):
                img_url = cand
        sections.append({"title": title, "text": block_text, "image": img_url, "links": section_links})
        seen_titles.add(low_title)
    return sections


def parse_sections_from_plain_text(text: str) -> List[Dict[str, str]]:
    if not text:
        return []
    lines = [clean(x) for x in re.split(r"[\n\r]+", text) if clean(x)]
    sections: List[Dict[str, str]] = []
    i = 0
    while i < len(lines):
        line = normalize_title(lines[i])
        low = line.lower()
        is_headingish = (
            7 <= len(line) <= 130
            and (
                any(k in low for k in EVENT_SECTION_HINTS)
                or (line == line.upper() and len(line.split()) <= 14)
                or re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec)\b", low)
            )
        )
        if not is_headingish or is_noise_title(line):
            i += 1
            continue
        buff = [line]
        j = i + 1
        # collect nearby lines until next heading-like line
        while j < len(lines):
            nxt = lines[j]
            nxt_low = nxt.lower()
            next_heading = (
                7 <= len(nxt) <= 130
                and (
                    any(k in nxt_low for k in EVENT_SECTION_HINTS)
                    or (nxt == nxt.upper() and len(nxt.split()) <= 14)
                )
                and not is_noise_title(nxt)
            )
            if next_heading and len(buff) >= 2:
                break
            buff.append(nxt)
            if len(buff) >= 12:
                break
            j += 1
        block = clean(" ".join(buff))
        if len(block) >= 30:
            sections.append({"title": line, "text": block, "image": "", "links": []})
        i = max(j, i + 1)
    # dedupe by title
    seen = set()
    out: List[Dict[str, str]] = []
    for s in sections:
        t = title_key(s.get("title", ""))
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(s)
    return out


def parse_contents_items(text: str) -> List[Dict[str, str]]:
    """
    Parse newsletter Contents list into lightweight event title sections.
    """
    if not text:
        return []
    lines = [clean(x) for x in re.split(r"[\n\r]+", text) if clean(x)]
    out: List[Dict[str, str]] = []
    in_contents = False
    for line in lines:
        low = line.lower()
        if low == "contents" or low.endswith("contents"):
            in_contents = True
            continue
        if in_contents and (
            low.startswith("quran ayat")
            or low.startswith("prayer timing")
            or low.startswith("muslim center services")
            or low.startswith("regular events")
        ):
            # skip structural items but continue
            continue
        if in_contents:
            line_norm = normalize_title(line)
            low_norm = line_norm.lower()
            if len(line_norm) < 6 or len(line_norm) > 160:
                continue
            if is_noise_title(line_norm):
                continue
            if title_quality_score(line_norm) < 1:
                continue
            if re.match(r"^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", low_norm):
                continue
            if any(k in low_norm for k in EVENT_SECTION_HINTS) or re.search(r"\b(apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}/\d{1,2})\b", low_norm):
                out.append({"title": line_norm, "text": line_norm, "image": "", "links": []})
            # stop if we reached clear non-contents body salutation
            if low.startswith("asalaamualaikum") and len(out) >= 3:
                break
    # dedupe
    seen = set()
    ded: List[Dict[str, str]] = []
    for x in out:
        t = title_key(x["title"])
        if t and t not in seen:
            seen.add(t)
            ded.append(x)
    return ded[:20]


def parse_anchor_sections_from_html(html: str, titles: List[str]) -> List[Dict[str, str]]:
    """
    Anchor-based extraction:
    map contents titles to nearest HTML blocks and collect nearest poster + links.
    """
    if not html or not titles:
        return []
    soup = BeautifulSoup(html, "lxml")
    sections: List[Dict[str, str]] = []
    for title in titles:
        tkey = title_key(title)
        if not tkey:
            continue
        # Find anchor/link that best matches title.
        match_anchor = None
        for a in soup.find_all("a", href=True):
            at = normalize_title(a.get_text(" ", strip=True))
            if not at:
                continue
            akey = title_key(at)
            if not akey:
                continue
            if akey == tkey or akey in tkey or tkey in akey:
                match_anchor = a
                break
        container = None
        if match_anchor is not None:
            container = match_anchor
            # climb to stable block
            for _ in range(6):
                if not container:
                    break
                if getattr(container, "name", "") in {"td", "tr", "table", "div", "section", "p"}:
                    break
                container = container.parent
        if container is None:
            # fallback: find any text node match
            for node in soup.find_all(string=True):
                txt = normalize_title(str(node))
                if not txt:
                    continue
                nkey = title_key(txt)
                if nkey == tkey or nkey in tkey or tkey in nkey:
                    container = node.parent
                    break
        if container is None:
            continue
        # Build block text from container + a few siblings
        blocks = [clean(container.get_text(" ", strip=True))]
        links: List[str] = []
        images: List[str] = []
        def collect_from(node):
            for a in node.find_all("a", href=True):
                u = clean(a["href"])
                if u.startswith("http") and u not in links:
                    links.append(u)
            for img in node.find_all("img", src=True):
                u = clean(img["src"])
                if u.startswith("http") and not any(h in u.lower() for h in BAD_IMAGE_HINTS) and u not in images:
                    images.append(u)
        collect_from(container)
        sib = container
        for _ in range(3):
            sib = sib.find_next_sibling()
            if not sib:
                break
            stext = clean(sib.get_text(" ", strip=True))
            if stext:
                blocks.append(stext)
            collect_from(sib)
        block_text = clean(" ".join(blocks))
        if len(block_text) < 20:
            continue
        sections.append(
            {
                "title": normalize_title(title),
                "text": block_text,
                "image": images[0] if images else "",
                "links": links,
            }
        )
    # dedupe
    seen = set()
    out: List[Dict[str, str]] = []
    for s in sections:
        k = title_key(s.get("title", ""))
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def parse_sections_by_titles_from_text(text: str, titles: List[str]) -> List[Dict[str, str]]:
    if not text or not titles:
        return []
    lines = [clean(x) for x in re.split(r"[\n\r]+", text) if clean(x)]
    title_map = {title_key(t): normalize_title(t) for t in titles if title_key(t)}
    title_keys = list(title_map.keys())
    sections: List[Dict[str, str]] = []
    current_title = ""
    buff: List[str] = []
    def flush():
        nonlocal current_title, buff
        if current_title and buff:
            sections.append({"title": current_title, "text": clean(" ".join(buff)), "image": "", "links": []})
        current_title = ""
        buff = []
    for line in lines:
        lk = title_key(line)
        matched_key = None
        for tk in title_keys:
            if lk == tk or (lk and (lk in tk or tk in lk)):
                matched_key = tk
                break
        if matched_key:
            flush()
            current_title = title_map[matched_key]
            buff = [line]
            continue
        if current_title:
            buff.append(line)
    flush()
    return [s for s in sections if len(clean(s.get("text", ""))) >= 20]


def infer_audience(text: str) -> str:
    t = clean(text).lower()
    if re.search(r"\b(sister|sisters|girls|women)\b", t):
        return "sisters"
    if re.search(r"\b(brother|brothers|men|boys)\b", t):
        return "brothers"
    if re.search(r"\b(family|families|kids|children|parents)\b", t):
        return "family"
    return ""


def infer_category(text: str) -> str:
    t = clean(text).lower()
    for key in ("halaqa", "workshop", "lecture", "seminar", "class", "fundraiser", "youth", "ramadan", "eid"):
        if key in t:
            return key
    return ""


def extract_rsvp(links: List[str], text: str) -> str:
    for u in links:
        low = u.lower()
        if "login.mailchimp.com" in low:
            continue
        if any(h in low for h in RSVP_HINTS):
            return u
    text_low = clean(text).lower()
    if any(h in text_low for h in RSVP_HINTS):
        for u in links:
            if u.startswith("http"):
                return u
    return ""


def parse_times(text: str) -> Tuple[str, str]:
    m = TIME_RANGE_RX.search(text)
    if m:
        return clean(m.group(1)), clean(m.group(2))
    m2 = TIME_SINGLE_RX.search(text)
    if m2:
        return clean(m2.group(1)), ""
    return "", ""


def parse_date(text: str, msg_date: datetime) -> str:
    m = DATE_RX.search(text)
    if m:
        parsed = dateparser.parse(
            m.group(0),
            settings={"PREFER_DATES_FROM": "future", "RELATIVE_BASE": msg_date},
        )
        if parsed:
            return parsed.date().isoformat()
    return msg_date.date().isoformat()


def extract_dates_multi(text: str, msg_date: datetime) -> List[str]:
    out: List[str] = []
    # month/day named date matches
    for m in DATE_RX.finditer(text):
        chunk = m.group(0)
        settings = {"PREFER_DATES_FROM": "future", "RELATIVE_BASE": msg_date}
        if re.search(r"\b20\d{2}\b", chunk):
            settings = {"RELATIVE_BASE": msg_date}
        parsed = dateparser.parse(chunk, settings=settings)
        if parsed:
            d = parsed.date().isoformat()
            if d not in out:
                out.append(d)
    # numeric mm/dd(/yyyy) matches
    for m in MMDD_RX.finditer(text):
        mon = int(m.group(1))
        day = int(m.group(2))
        yr_raw = m.group(3)
        year = msg_date.year
        if yr_raw:
            year = int(yr_raw)
            if year < 100:
                year += 2000
        try:
            d = datetime(year, mon, day).date().isoformat()
            if d not in out:
                out.append(d)
        except ValueError:
            continue
    if not out:
        out.append(parse_date(text, msg_date))
    return sorted(out)


def extract_title_candidates(text: str, subject: str) -> List[str]:
    out: List[str] = []
    lines = [clean(x) for x in re.split(r"[\n\r]+", text) if clean(x)]
    for line in lines[:80]:
        if len(line) < 6 or len(line) > 120:
            continue
        low = line.lower()
        if DATE_RX.search(low) or TIME_SINGLE_RX.search(low):
            continue
        if any(x in low for x in ("unsubscribe", "view in browser", "copyright", "privacy policy")):
            continue
        # Prefer stronger heading-like lines.
        if line == line.upper() or line.istitle() or any(k in low for k in ("program", "halaqa", "class", "event", "lecture", "workshop", "khatira", "jummah")):
            out.append(line)
        if len(out) >= 8:
            break
    if subject and subject not in out:
        out.insert(0, subject)
    dedup: List[str] = []
    for t in out:
        if t not in dedup:
            dedup.append(t)
    return dedup[:8]


def build_events_from_email(
    *,
    source: str,
    subject: str,
    sender: str,
    msg_id: str,
    msg_date: datetime,
    text_blob: str,
    links: List[str],
    images: List[str],
    section_title: Optional[str] = None,
    section_image: Optional[str] = None,
    section_links: Optional[List[str]] = None,
    allow_global_rsvp_links: bool = True,
) -> List[Dict]:
    if section_title:
        titles = [normalize_title(section_title)]
    else:
        titles = extract_title_candidates(text_blob, subject)
    if not titles:
        titles = [subject or "Masjid Event Update"]
    dates = extract_dates_multi(text_blob, msg_date)
    if section_title:
        title_dates = extract_dates_multi(section_title, msg_date)
        # If title encodes explicit dates, trust it over longer block text.
        if title_dates and not (len(title_dates) == 1 and title_dates[0] == msg_date.date().isoformat()):
            dates = title_dates
    start_time, end_time = parse_times(text_blob)
    local_links = [x for x in (section_links or []) if x]
    effective_links = local_links or links
    if not allow_global_rsvp_links and local_links:
        effective_links = local_links
    elif not allow_global_rsvp_links and not local_links:
        effective_links = []
    rsvp = extract_rsvp(effective_links, text_blob)
    audience = infer_audience(" ".join([subject, text_blob]))
    category = infer_category(" ".join([subject, text_blob]))
    speaker = ""
    sp = re.search(
        r"\b(?:imam|shaykh|sheikh|ustadh|dr\.?|qari)\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,3}",
        text_blob,
        flags=re.I,
    )
    if sp:
        speaker = clean(sp.group(0))
    meta = SOURCE_META.get(source, {})
    source_url = f"email://{msg_id}"
    desc = clean(text_blob)
    if len(desc) > 700:
        desc = desc[:700]
    visitor_note_parts = []
    if start_time:
        visitor_note_parts.append(f"Arrive by {start_time}.")
    if meta.get("location_name"):
        visitor_note_parts.append(f"Venue: {meta.get('location_name')}.")
    if meta.get("address"):
        visitor_note_parts.append(f"Address: {meta.get('address')}, {meta.get('city')}, {meta.get('state')} {meta.get('zip')}.")
    if rsvp:
        visitor_note_parts.append("Registration may be required; use RSVP link.")
    else:
        visitor_note_parts.append("If registration is unclear, call or check masjid channels before attending.")
    visitor_note = " ".join(visitor_note_parts)
    out: List[Dict] = []
    selected_images = images[:8]
    if section_image and section_image.startswith("http"):
        selected_images = [section_image] + [x for x in selected_images if x != section_image]
    for title in titles:
        for date_iso in dates[:10]:
            out.append(
                {
                    "source": source,
                    "source_type": "email",
                    "source_url": source_url,
                    "title": normalize_title(title),
                    "description": desc,
                    "date": date_iso,
                    "start_time": start_time,
                    "end_time": end_time,
                    "location_name": meta.get("location_name", ""),
                    "address": meta.get("address", ""),
                    "city": meta.get("city", ""),
                    "state": meta.get("state", ""),
                    "zip": meta.get("zip", ""),
                    "category": category,
                    "audience": audience,
                    "organizer": meta.get("organizer", ""),
                    "rsvp_link": rsvp,
                    "image_urls": selected_images,
                    "raw_text": clean(f"sender={sender} subject={subject} body={text_blob}")[:1800],
                    "confidence": 0.68 if date_iso else 0.5,
                    "speaker": speaker,
                    "visitor_note": visitor_note,
                }
            )
    return out


def dedupe_events(rows: List[Dict]) -> List[Dict]:
    seen = set()
    out: List[Dict] = []
    for e in rows:
        source_type = clean(str(e.get("source_type", ""))).lower()
        normalized_title = title_key(str(e.get("title", ""))) if source_type == "email" else clean(str(e.get("title", ""))).lower()
        key = (
            clean(str(e.get("source", ""))).lower(),
            normalized_title,
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


def pick_better_title(current: str, candidate: str) -> str:
    c = normalize_title(current)
    n = normalize_title(candidate)
    if not c:
        return n
    if not n:
        return c
    # Prefer richer but not overly long title.
    c_score = title_quality_score(c) + min(len(c), 90) / 100.0
    n_score = title_quality_score(n) + min(len(n), 90) / 100.0
    if n_score > c_score:
        return n
    return c


def merge_email_event_group(group: List[Dict]) -> Dict:
    base = dict(group[0])
    for e in group[1:]:
        base["title"] = pick_better_title(str(base.get("title", "")), str(e.get("title", "")))
        if len(clean(str(e.get("description", "")))) > len(clean(str(base.get("description", "")))):
            base["description"] = clean(str(e.get("description", "")))
        # Prefer explicit time info.
        if not clean(str(base.get("start_time", ""))) and clean(str(e.get("start_time", ""))):
            base["start_time"] = clean(str(e.get("start_time", "")))
        if not clean(str(base.get("end_time", ""))) and clean(str(e.get("end_time", ""))):
            base["end_time"] = clean(str(e.get("end_time", "")))
        # Prefer non-empty RSVP.
        cur_rsvp = clean(str(base.get("rsvp_link", "")))
        new_rsvp = clean(str(e.get("rsvp_link", "")))
        if not cur_rsvp and new_rsvp:
            base["rsvp_link"] = new_rsvp
        # Merge poster URLs.
        imgs = []
        for row in (base, e):
            for u in (row.get("image_urls") or []):
                uu = clean(str(u))
                if uu.startswith("http") and uu not in imgs:
                    imgs.append(uu)
        if imgs:
            base["image_urls"] = imgs[:10]
        # Prefer speaker/category/audience if missing.
        for field in ("speaker", "category", "audience", "organizer", "location_name", "address", "city", "state", "zip"):
            if not clean(str(base.get(field, ""))) and clean(str(e.get(field, ""))):
                base[field] = e.get(field, "")
        if len(clean(str(e.get("visitor_note", "")))) > len(clean(str(base.get("visitor_note", "")))):
            base["visitor_note"] = clean(str(e.get("visitor_note", "")))
        # Keep strongest confidence and richer raw_text.
        base["confidence"] = max(float(base.get("confidence", 0) or 0), float(e.get("confidence", 0) or 0))
        if len(clean(str(e.get("raw_text", "")))) > len(clean(str(base.get("raw_text", "")))):
            base["raw_text"] = clean(str(e.get("raw_text", "")))
    return base


def collapse_email_duplicates(rows: List[Dict]) -> List[Dict]:
    grouped: Dict[Tuple[str, str, str, str], List[Dict]] = {}
    passthrough: List[Dict] = []
    for e in rows:
        if clean(str(e.get("source_type", ""))).lower() != "email":
            passthrough.append(e)
            continue
        key = (
            clean(str(e.get("source", ""))).lower(),
            clean(str(e.get("date", ""))),
            merge_title_key(str(e.get("title", ""))) or title_key(str(e.get("title", ""))),
            clean(str(e.get("source_url", ""))).lower(),
        )
        grouped.setdefault(key, []).append(e)
    merged_email = [merge_email_event_group(v) for v in grouped.values()]
    out = passthrough + merged_email
    out.sort(key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or ""))
    return out


def is_noise_email_event(e: Dict) -> bool:
    if clean(str(e.get("source_type", ""))).lower() != "email":
        return False
    title_low = clean(str(e.get("title", ""))).lower()
    if any(h in title_low for h in NON_EVENT_SECTION_HINTS) or is_noise_title(title_low):
        return True
    source = clean(str(e.get("source", ""))).lower()
    if source != "mcmc" and title_quality_score(title_low) < 1:
        return True
    if re.match(r"^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", title_low):
        return True
    desc = clean(str(e.get("description", "")))
    if source == "mcgp" and not event_like_for_source("mcgp", title_low, desc):
        return True
    if source == "mcmc" and not event_like_for_source("mcmc", title_low, desc):
        return True
    # If title includes explicit dates, event row date should align.
    title_raw = clean(str(e.get("title", "")))
    if DATE_RX.search(title_raw) or MMDD_RX.search(title_raw):
        d = clean(str(e.get("date", "")))
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            title_dates = extract_dates_multi(title_raw, datetime.utcnow())
            if title_dates and d not in title_dates:
                return True
    # Guard against malformed future years from subject-only parsing.
    d = clean(str(e.get("date", "")))
    if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        try:
            dt = datetime.strptime(d, "%Y-%m-%d").date()
            if dt > (datetime.utcnow().date() + timedelta(days=220)):
                return True
        except Exception:
            pass
    return False


def build_visitor_note_from_row(e: Dict) -> str:
    start = clean(str(e.get("start_time", "")))
    loc_name = clean(str(e.get("location_name", "")))
    address = clean(str(e.get("address", "")))
    city = clean(str(e.get("city", "")))
    state = clean(str(e.get("state", "")))
    zip_code = clean(str(e.get("zip", "")))
    rsvp = clean(str(e.get("rsvp_link", "")))
    parts: List[str] = []
    if start:
        parts.append(f"Arrive by {start}.")
    if loc_name:
        parts.append(f"Venue: {loc_name}.")
    addr_tail = clean(" ".join([city, state, zip_code]))
    if address:
        if addr_tail and addr_tail.lower() not in address.lower():
            parts.append(f"Address: {address}, {addr_tail}.")
        else:
            parts.append(f"Address: {address}.")
    if rsvp:
        parts.append("Registration may be required; use RSVP link.")
    else:
        parts.append("If registration is unclear, check masjid social channels before attending.")
    return clean(" ".join(parts))


_POSTER_OCR_CACHE: Dict[str, str] = {}
_POSTER_OVERRIDE_CACHE: Optional[Dict[str, List[str]]] = None


def load_poster_overrides() -> Dict[str, List[str]]:
    global _POSTER_OVERRIDE_CACHE
    if _POSTER_OVERRIDE_CACHE is not None:
        return _POSTER_OVERRIDE_CACHE
    default = {"approved": [], "blocked": []}
    if not POSTER_OVERRIDE_FILE.exists():
        _POSTER_OVERRIDE_CACHE = default
        return _POSTER_OVERRIDE_CACHE
    try:
        parsed = json.loads(POSTER_OVERRIDE_FILE.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            _POSTER_OVERRIDE_CACHE = default
            return _POSTER_OVERRIDE_CACHE
        approved = [clean(x) for x in (parsed.get("approved") or []) if clean(x)]
        blocked = [clean(x) for x in (parsed.get("blocked") or []) if clean(x)]
        _POSTER_OVERRIDE_CACHE = {"approved": approved, "blocked": blocked}
    except Exception:
        _POSTER_OVERRIDE_CACHE = default
    return _POSTER_OVERRIDE_CACHE


def ocr_local_image(path: Path) -> str:
    k = str(path)
    if k in _POSTER_OCR_CACHE:
        return _POSTER_OCR_CACHE[k]
    if not path.exists():
        _POSTER_OCR_CACHE[k] = ""
        return ""
    try:
        proc = subprocess.run(
            ["tesseract", str(path), "stdout", "-l", "eng"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=12,
            check=False,
            text=True,
        )
        txt = clean(proc.stdout or "")[:2500]
        _POSTER_OCR_CACHE[k] = txt
        return txt
    except Exception:
        _POSTER_OCR_CACHE[k] = ""
        return ""


def poster_relevance_score(path: Path, ocr_text: str) -> int:
    name = clean(path.name).lower()
    low = clean(ocr_text).lower()
    score = 0
    if any(h in name for h in BAD_IMAGE_HINTS):
        score -= 3
    if "logo" in low:
        score -= 2
    if re.search(r"\b(apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}/\d{1,2}|20\d{2})\b", low):
        score += 2
    if TIME_SINGLE_RX.search(low):
        score += 1
    if any(k in low for k in POSTER_EVENT_HINTS):
        score += 2
    if len(low.split()) >= 15:
        score += 1
    if len(low) < 20:
        score -= 2
    return score


def review_path_for(source: str, file_name: str) -> Path:
    return POSTERS_REVIEW_DIR / (clean(source).lower() or "unknown") / file_name


def classify_local_poster(source: str, rel_or_local: str) -> Tuple[bool, str]:
    """
    Returns (is_relevant, path_to_keep_or_review).
    """
    p = clean(rel_or_local)
    if not p:
        return False, ""
    if p.startswith("http"):
        return True, p
    rel = Path(p)
    abs_path = BASE / rel
    if not abs_path.exists():
        return False, ""
    ov = load_poster_overrides()
    rel_str = str(rel)
    file_name = abs_path.name
    if rel_str in ov.get("approved", []) or file_name in ov.get("approved", []):
        return True, rel_str
    if rel_str in ov.get("blocked", []) or file_name in ov.get("blocked", []):
        review_abs = review_path_for(source, abs_path.name)
        review_abs.parent.mkdir(parents=True, exist_ok=True)
        if not review_abs.exists():
            shutil.copy2(abs_path, review_abs)
        return False, str(review_abs.relative_to(BASE))
    # Already in review bucket.
    if "_needs_review" in abs_path.parts:
        return False, p
    ocr_text = ocr_local_image(abs_path)
    score = poster_relevance_score(abs_path, ocr_text)
    keep_threshold = 2
    if clean(source).lower() == "mcmc":
        # MCMC email flyers are often text-light but still valid program posters.
        keep_threshold = 0
    if score >= keep_threshold:
        return True, p
    review_abs = review_path_for(source, abs_path.name)
    review_abs.parent.mkdir(parents=True, exist_ok=True)
    if not review_abs.exists():
        shutil.copy2(abs_path, review_abs)
    review_rel = review_abs.relative_to(BASE)
    return False, str(review_rel)


def audit_source_posters(source: str) -> None:
    src_dir = POSTERS_DIR / (clean(source).lower() or "unknown")
    if not src_dir.exists():
        return
    for p in src_dir.glob("*"):
        if not p.is_file():
            continue
        classify_local_poster(source, str(p.relative_to(BASE)))


def extension_from_url(url: str) -> str:
    parsed = urlparse(url)
    name = (parsed.path.rsplit("/", 1)[-1] or "").lower()
    if "." in name:
        ext = "." + name.rsplit(".", 1)[-1]
        if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            return ext
    return ".jpg"


def download_image_to_local(source: str, image_url: str) -> str:
    """
    Download remote poster once and return DB-storable relative path.
    """
    u = clean(image_url)
    if not u.startswith("http"):
        return u
    source_key = clean(source).lower() or "unknown"
    digest = hashlib.sha1(u.encode("utf-8")).hexdigest()[:20]
    ext = extension_from_url(u)
    rel = Path("events_by_masjid") / "posters" / source_key / f"{digest}{ext}"
    abs_path = BASE / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    if not abs_path.exists():
        req = Request(u, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urlopen(req, timeout=15) as resp:
                data = resp.read()
            if data:
                abs_path.write_bytes(data)
            else:
                return ""
        except Exception:
            return ""
    return str(rel)


def normalize_email_event(e: Dict) -> Dict:
    if clean(str(e.get("source_type", ""))).lower() != "email":
        return e
    out = dict(e)
    rsvp = clean(str(out.get("rsvp_link", "")))
    if "login.mailchimp.com" in rsvp.lower():
        out["rsvp_link"] = ""
    imgs = out.get("image_urls") or []
    source = clean(str(out.get("source", ""))).lower()
    local_urls: List[str] = []
    review_urls: List[str] = []
    for u in imgs:
        uu = clean(str(u))
        if not uu:
            continue
        if uu.startswith("http"):
            local = download_image_to_local(source, uu)
            if local:
                ok, keep_path = classify_local_poster(source, local)
                if ok and keep_path and keep_path not in local_urls:
                    local_urls.append(keep_path)
                elif (not ok) and keep_path and keep_path not in review_urls:
                    review_urls.append(keep_path)
        else:
            ok, keep_path = classify_local_poster(source, uu)
            if ok and keep_path and keep_path not in local_urls:
                local_urls.append(keep_path)
            elif (not ok) and keep_path and keep_path not in review_urls:
                review_urls.append(keep_path)
    # Keep DB-facing images local so no mailchimp URL is exposed.
    out["image_urls"] = local_urls[:10]
    if review_urls:
        out["image_review_urls"] = review_urls[:10]
    elif "image_review_urls" in out:
        out.pop("image_review_urls", None)
    if "image_source_urls" in out:
        out.pop("image_source_urls", None)
    if not clean(str(out.get("visitor_note", ""))):
        out["visitor_note"] = build_visitor_note_from_row(out)
    return out


def merge_events_into_source(source: str, new_events: List[Dict]) -> int:
    out_path = EVENTS_DIR / f"{source}_events.json"
    existing = load_json(out_path)
    merged = [normalize_email_event(e) for e in (existing + new_events)]
    merged = dedupe_events(merged)
    merged = collapse_email_duplicates(merged)
    merged = [e for e in merged if not is_noise_email_event(e)]
    if clean(source).lower() == "mcmc":
        merged = backfill_mcmc_event_images(merged)
    save_json(out_path, merged)
    return len(merged)


def parse_generic_digest(
    *,
    source: str,
    subject: str,
    sender: str,
    msg_id: str,
    msg_date: datetime,
    text_body: str,
    html_body: str,
    links: List[str],
    images: List[str],
) -> List[Dict]:
    sections_html = parse_sections_from_html(html_body)
    sections_text = parse_sections_from_plain_text(text_body)
    sections = sections_html + sections_text
    events: List[Dict] = []
    if sections:
        for sec in sections:
            title = sec.get("title", "")
            sec_text = clean(sec.get("text", ""))
            if not event_like_for_source(source, title, sec_text):
                continue
            events.extend(
                build_events_from_email(
                    source=source,
                    subject=subject,
                    sender=sender,
                    msg_id=msg_id,
                    msg_date=msg_date,
                    text_blob=sec_text,
                    links=links,
                    images=images,
                    section_title=title,
                    section_image=sec.get("image", ""),
                    section_links=sec.get("links", []),
                )
            )
    else:
        blob = clean(" ".join([subject, text_body, html_body]))
        events = build_events_from_email(
            source=source,
            subject=subject,
            sender=sender,
            msg_id=msg_id,
            msg_date=msg_date,
            text_blob=blob,
            links=links,
            images=images,
        )
    return events


def parse_mcgp_digest(
    *,
    source: str,
    subject: str,
    sender: str,
    msg_id: str,
    msg_date: datetime,
    text_body: str,
    html_body: str,
    links: List[str],
    images: List[str],
) -> List[Dict]:
    contents = parse_contents_items(text_body)
    contents_titles = [c.get("title", "") for c in contents if c.get("title")]
    anchor_sections = parse_anchor_sections_from_html(html_body, contents_titles)
    text_sections = parse_sections_by_titles_from_text(text_body, contents_titles)

    by_key: Dict[str, Dict[str, object]] = {}
    # Prefer text-sliced blocks over broad HTML containers.
    ranked_sections: List[Tuple[int, Dict[str, str]]] = []
    ranked_sections.extend((0, sec) for sec in contents)
    ranked_sections.extend((1, sec) for sec in anchor_sections)
    ranked_sections.extend((2, sec) for sec in text_sections)
    for rank, sec in ranked_sections:
        title = normalize_title(str(sec.get("title", "")))
        if not title or is_noise_title(title):
            continue
        k = title_key(title)
        if not k:
            continue
        text_val = clean(str(sec.get("text", "")))
        image_val = clean(str(sec.get("image", "")))
        links_val = [clean(x) for x in (sec.get("links", []) or []) if clean(x).startswith("http")]
        if k not in by_key:
            by_key[k] = {
                "title": title,
                "text": text_val,
                "image": image_val,
                "links": links_val,
                "_rank": rank,
            }
        else:
            prev_rank = int(by_key[k].get("_rank", -1))
            if rank > prev_rank:
                by_key[k]["text"] = text_val
                by_key[k]["_rank"] = rank
            elif rank == prev_rank and len(text_val) > len(clean(str(by_key[k].get("text", "")))):
                by_key[k]["text"] = text_val
            if image_val and not by_key[k].get("image"):
                by_key[k]["image"] = image_val
            # merge links
            existing_links = list(by_key[k].get("links", []) or [])
            for u in links_val:
                if u not in existing_links:
                    existing_links.append(u)
            by_key[k]["links"] = existing_links

    sections = list(by_key.values())
    events: List[Dict] = []
    for sec in sections:
        title = str(sec.get("title", ""))
        sec_text = clean(str(sec.get("text", "")))
        if not event_like_for_source("mcgp", title, sec_text):
            continue
        # section-level RSVP mapping priority (mcgp.link etc in this block)
        sec_links = [u for u in (sec.get("links", []) or []) if u.startswith("http")]
        events.extend(
            build_events_from_email(
                source=source,
                subject=subject,
                sender=sender,
                msg_id=msg_id,
                msg_date=msg_date,
                text_blob=sec_text or title,
                links=links,
                images=images,
                section_title=title,
                section_image=str(sec.get("image", "")),
                section_links=sec_links,
                allow_global_rsvp_links=False,
            )
        )
    # fallback to generic if digest parse found nothing
    if not events:
        return parse_generic_digest(
            source=source,
            subject=subject,
            sender=sender,
            msg_id=msg_id,
            msg_date=msg_date,
            text_body=text_body,
            html_body=html_body,
            links=links,
            images=images,
        )
    return events


def parse_mcmc_digest(
    *,
    source: str,
    subject: str,
    sender: str,
    msg_id: str,
    msg_date: datetime,
    text_body: str,
    html_body: str,
    links: List[str],
    images: List[str],
) -> List[Dict]:
    events = parse_generic_digest(
        source=source,
        subject=subject,
        sender=sender,
        msg_id=msg_id,
        msg_date=msg_date,
        text_body=text_body,
        html_body=html_body,
        links=links,
        images=images,
    )
    events.extend(
        build_mcmc_events_from_posters(
            source=source,
            subject=subject,
            sender=sender,
            msg_id=msg_id,
            msg_date=msg_date,
            images=images,
        )
    )
    events.extend(
        build_mcmc_events_from_local_poster_library(
            source=source,
            msg_id=msg_id,
            msg_date=msg_date,
        )
    )
    return dedupe_events(events)


def infer_mcmc_title_from_ocr(text: str) -> str:
    low = clean(text).lower()
    for needle, title in MCMC_POSTER_TITLE_PATTERNS:
        if needle in low:
            return title
    if "haj" in low and "seminar" in low:
        return "Hajj Seminar"
    if "soccer" in low and ("academy" in low or "season" in low):
        return "Soccer Academy"
    if "prophetic path" in low:
        return "Prophetic Path"
    if "sisters" in low and "workout" in low:
        return "Sisters Workout Class"
    if "icky" in low and "cozy" in low:
        return "From Icky to Cozy"
    if "breakfast club" in low:
        return "Breakfast Club"
    return ""


def build_mcmc_events_from_posters(
    *,
    source: str,
    subject: str,
    sender: str,
    msg_id: str,
    msg_date: datetime,
    images: List[str],
) -> List[Dict]:
    out: List[Dict] = []
    meta = SOURCE_META.get(source, {})
    source_url = f"email://{msg_id}"
    seen = set()
    for u in images[:20]:
        local_rel = download_image_to_local(source, u)
        if not local_rel:
            continue
        local_abs = BASE / local_rel
        ocr_text = ocr_local_image(local_abs)
        title = infer_mcmc_title_from_ocr(ocr_text)
        if not title:
            continue
        dates = extract_dates_multi(ocr_text, msg_date)
        start_time, end_time = parse_times(ocr_text)
        desc = clean(ocr_text)[:700]
        audience = infer_audience(" ".join([title, desc]))
        category = infer_category(" ".join([title, desc]))
        for d in dates[:10]:
            k = (title.lower(), d)
            if k in seen:
                continue
            seen.add(k)
            out.append(
                {
                    "source": source,
                    "source_type": "email",
                    "source_url": source_url,
                    "title": title,
                    "description": desc,
                    "date": d,
                    "start_time": start_time,
                    "end_time": end_time,
                    "location_name": meta.get("location_name", ""),
                    "address": meta.get("address", ""),
                    "city": meta.get("city", ""),
                    "state": meta.get("state", ""),
                    "zip": meta.get("zip", ""),
                    "category": category,
                    "audience": audience,
                    "organizer": meta.get("organizer", ""),
                    "rsvp_link": "",
                    "image_urls": [local_rel],
                    "raw_text": clean(f"sender={sender} subject={subject} poster_ocr={ocr_text}")[:1800],
                    "confidence": 0.62,
                    "speaker": "",
                }
            )
    return out


def build_mcmc_events_from_local_poster_library(
    *,
    source: str,
    msg_id: str,
    msg_date: datetime,
) -> List[Dict]:
    out: List[Dict] = []
    src_dir = POSTERS_DIR / "mcmc"
    if not src_dir.exists():
        return out
    meta = SOURCE_META.get(source, {})
    seen = set()
    for p in sorted(src_dir.glob("*"))[:80]:
        if not p.is_file():
            continue
        rel = str(p.relative_to(BASE))
        ocr_text = ocr_local_image(p)
        title = infer_mcmc_title_from_ocr(ocr_text)
        if not title:
            continue
        dates = extract_dates_multi(ocr_text, msg_date)
        start_time, end_time = parse_times(ocr_text)
        desc = clean(ocr_text)[:700]
        audience = infer_audience(" ".join([title, desc]))
        category = infer_category(" ".join([title, desc]))
        for d in dates[:10]:
            k = (title.lower(), d)
            if k in seen:
                continue
            seen.add(k)
            out.append(
                {
                    "source": source,
                    "source_type": "email",
                    "source_url": f"email://{msg_id}",
                    "title": title,
                    "description": desc,
                    "date": d,
                    "start_time": start_time,
                    "end_time": end_time,
                    "location_name": meta.get("location_name", ""),
                    "address": meta.get("address", ""),
                    "city": meta.get("city", ""),
                    "state": meta.get("state", ""),
                    "zip": meta.get("zip", ""),
                    "category": category,
                    "audience": audience,
                    "organizer": meta.get("organizer", ""),
                    "rsvp_link": "",
                    "image_urls": [rel],
                    "raw_text": clean(f"poster_ocr={ocr_text}")[:1800],
                    "confidence": 0.6,
                    "speaker": "",
                }
            )
    return out


def build_mcmc_poster_index() -> Dict[str, str]:
    out: Dict[str, str] = {}
    src_dir = POSTERS_DIR / "mcmc"
    if not src_dir.exists():
        return out
    for p in sorted(src_dir.glob("*")):
        if not p.is_file():
            continue
        ocr_text = ocr_local_image(p)
        title = infer_mcmc_title_from_ocr(ocr_text)
        if not title:
            continue
        k = title_key(title)
        if not k:
            continue
        out.setdefault(k, str(p.relative_to(BASE)))
    return out


def discover_senders_from_inbox() -> None:
    """
    Print From addresses from recent inbox mail: which map to a masjid source
    vs which need a new row in _email_sender_rules.json. Does not write events.
    """
    user = clean(os.getenv("GMAIL_USER", ""))
    password = clean(os.getenv("GMAIL_APP_PASSWORD", ""))
    if not user or not password:
        raise SystemExit("Missing GMAIL_USER or GMAIL_APP_PASSWORD env var.")

    lookback = int(os.getenv("EMAIL_DISCOVER_LOOKBACK_DAYS", str(LOOKBACK_DAYS)))
    max_n = int(os.getenv("EMAIL_DISCOVER_MAX_MESSAGES", "500"))
    since = (datetime.utcnow() - timedelta(days=lookback)).strftime("%d-%b-%Y")

    unmapped: Dict[str, Dict[str, object]] = {}
    mapped_counts: Dict[str, int] = {}
    ids: List[bytes] = []

    imap = imaplib.IMAP4_SSL(GMAIL_HOST)
    try:
        imap.login(user, password)
        imap.select(GMAIL_FOLDER)
        typ, data = imap.search(None, "SINCE", since)
        if typ != "OK":
            raise RuntimeError("IMAP search failed")
        ids = data[0].split()[-max_n:]
        for mid in ids:
            typ2, msg_data = imap.fetch(mid, "(RFC822)")
            if typ2 != "OK" or not msg_data or not msg_data[0]:
                continue
            raw_bytes = msg_data[0][1]
            msg = email.message_from_bytes(raw_bytes)
            sender = decode_mime_text(msg.get("From", ""))
            subject = decode_mime_text(msg.get("Subject", ""))
            text_body, html_body = parse_message_bodies(msg)
            source = detect_source(sender) or detect_source_from_content(subject, text_body, html_body)
            if source:
                mapped_counts[source] = mapped_counts.get(source, 0) + 1
                continue
            key = sender.strip() or "(empty-from)"
            slot = unmapped.setdefault(key, {"count": 0, "example_subject": ""})
            slot["count"] = int(slot.get("count", 0)) + 1
            if not clean(str(slot.get("example_subject", ""))):
                slot["example_subject"] = subject[:200]
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    print(f"discover_lookback_days={lookback} messages_scanned={len(ids)}")
    print("=== mapped_message_count_by_source (recent mail; rough) ===")
    for src in sorted(mapped_counts.keys()):
        print(f"{src}\t{mapped_counts[src]}")
    print("=== unmapped_from (count tab from tab example_subject) ===")
    rows = sorted(unmapped.items(), key=lambda kv: -int(kv[1]["count"]))  # type: ignore[arg-type]
    for from_hdr, meta in rows:
        c = int(meta["count"])
        ex = clean(str(meta.get("example_subject", "")))
        print(f"{c}\t{from_hdr}\t{ex}")
    print(
        "Hint: add high-signal substrings to events_by_masjid/_email_sender_rules.json "
        'as [["noreply@theirvendor.com", "icpc"], ...] — prepended before built-in rules.'
    )


def backfill_mcmc_event_images(rows: List[Dict]) -> List[Dict]:
    idx = build_mcmc_poster_index()
    if not idx:
        return rows
    out: List[Dict] = []
    for e in rows:
        row = dict(e)
        if clean(str(row.get("source", ""))).lower() != "mcmc":
            out.append(row)
            continue
        imgs = row.get("image_urls") or []
        if imgs:
            out.append(row)
            continue
        k = title_key(str(row.get("title", "")))
        if k in idx:
            row["image_urls"] = [idx[k]]
            out.append(row)
            continue
        # Relaxed fallback for variants like "COMMUNITY HAJJ SEMINAR".
        best = ""
        for kk, vv in idx.items():
            if not kk:
                continue
            if kk in k or k in kk:
                best = vv
                break
        if best:
            row["image_urls"] = [best]
        out.append(row)
    return out


def main() -> None:
    user = clean(os.getenv("GMAIL_USER", ""))
    password = os.getenv("GMAIL_APP_PASSWORD", "")
    if not user or not password:
        raise SystemExit("Missing GMAIL_USER or GMAIL_APP_PASSWORD env var.")

    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    processed = set(state.get("processed_message_ids", []))
    newly_processed: List[str] = []
    new_by_source: Dict[str, List[Dict]] = defaultdict(list)

    since = (datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    imap = imaplib.IMAP4_SSL(GMAIL_HOST)
    try:
        imap.login(user, password)
        imap.select(GMAIL_FOLDER)
        typ, data = imap.search(None, "SINCE", since)
        if typ != "OK":
            raise RuntimeError("IMAP search failed")
        ids = data[0].split()[-MAX_MESSAGES:]
        for mid in ids:
            typ2, msg_data = imap.fetch(mid, "(RFC822)")
            if typ2 != "OK" or not msg_data or not msg_data[0]:
                continue
            raw_bytes = msg_data[0][1]
            msg = email.message_from_bytes(raw_bytes)
            msg_id = clean(msg.get("Message-ID", "")) or f"imap-{mid.decode(errors='ignore')}"
            if msg_id in processed and not FORCE_REPROCESS:
                continue
            sender = decode_mime_text(msg.get("From", ""))
            subject = decode_mime_text(msg.get("Subject", ""))
            text_body, html_body = parse_message_bodies(msg)
            source = detect_source(sender) or detect_source_from_content(subject, text_body, html_body)
            if not source:
                continue
            msg_date_tuple = email.utils.parsedate_tz(msg.get("Date"))
            msg_date = datetime.utcnow()
            if msg_date_tuple:
                ts = email.utils.mktime_tz(msg_date_tuple)
                msg_date = datetime.utcfromtimestamp(ts)
            links, images, html_text = extract_links_images_from_html(html_body)
            text_blob = clean(" ".join([subject, text_body, html_text]))
            if len(text_blob) < 20:
                continue
            parser = {
                "mcgp": parse_mcgp_digest,
                "mcmc": parse_mcmc_digest,
            }.get(source, parse_generic_digest)
            events = parser(
                source=source,
                subject=subject,
                sender=sender,
                msg_id=msg_id,
                msg_date=msg_date,
                text_body=text_body,
                html_body=html_body,
                links=links,
                images=images,
            )
            if events:
                new_by_source[source].extend(events)
            newly_processed.append(msg_id)
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    for src, rows in new_by_source.items():
        if not rows:
            continue
        new_by_source[src] = dedupe_events(rows)
        total = merge_events_into_source(src, new_by_source[src])
        print(f"{src}: added={len(new_by_source[src])} total={total}")

    if newly_processed:
        processed.update(newly_processed)
        state["processed_message_ids"] = sorted(processed)[-5000:]
        save_state(state)
    print(f"processed_messages={len(newly_processed)}")


if __name__ == "__main__":
    w = os.getenv("EMAIL_DISCOVER_WRITE_RULES", "").strip().lower()
    d = os.getenv("EMAIL_DISCOVER_SENDERS", "").strip().lower()
    if w in ("1", "true", "yes"):
        sync_email_sender_rules_from_gmail()
    elif d in ("1", "true", "yes"):
        discover_senders_from_inbox()
    else:
        main()

