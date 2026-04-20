#!/usr/bin/env python3
"""
Cross-channel event reconciliation within a single masjid JSON file.

Merges rows that describe the same real-world event (website vs email vs Instagram)
when date + normalized title + time bucket align, using explicit source precedence.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Dict, List, Tuple


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def title_key(title: str) -> str:
    t = clean(title).lower()
    t = re.sub(r"^[^\w]+", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return clean(t)


def venue_fingerprint(e: Dict) -> str:
    parts = [
        clean(str(e.get("location_name", ""))).lower(),
        clean(str(e.get("address", ""))).lower(),
        clean(str(e.get("city", ""))).lower(),
    ]
    return "|".join(parts)


def normalize_time_bucket(st: str) -> str:
    t = clean(st).lower().replace(" ", "")
    if not t:
        return ""
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", t)
    if not m:
        return t[:16]
    h = int(m.group(1))
    ampm = m.group(3) or ""
    if ampm == "pm" and h < 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    return f"{h:02d}"


def source_type_rank(e: Dict) -> int:
    """Lower = higher trust for canonical fields (website scraper first)."""
    st = clean(str(e.get("source_type", ""))).lower()
    if st == "website":
        return 0
    if st == "email":
        return 2
    if st == "instagram":
        return 3
    if st == "instagram_recurring":
        return 4
    return 1


def _rsvp_score(url: str) -> int:
    u = clean(url).lower()
    if not u:
        return 0
    s = int(u.startswith("http"))
    for h in ("eventbrite", "forms.gle", "google.com/forms", "partiful", "lu.ma", "jotform", "ticket"):
        if h in u:
            s += 3
    return s


def merge_event_group(grp: List[Dict]) -> Dict:
    grp = [dict(x) for x in grp]
    grp.sort(key=source_type_rank)
    best = dict(grp[0])
    for e in grp[1:]:
        for field in ("start_time", "end_time", "location_name", "address", "city", "zip"):
            if not clean(str(best.get(field, ""))) and clean(str(e.get(field, ""))):
                best[field] = e.get(field, "")
        r1, r2 = clean(str(best.get("rsvp_link", ""))), clean(str(e.get("rsvp_link", "")))
        best["rsvp_link"] = r1 if _rsvp_score(r1) >= _rsvp_score(r2) else r2
        d1, d2 = clean(str(best.get("description", ""))), clean(str(e.get("description", "")))
        if len(d2) > len(d1):
            best["description"] = e.get("description", "")
        sp1, sp2 = clean(str(best.get("speaker", ""))), clean(str(e.get("speaker", "")))
        if len(sp2) > len(sp1):
            best["speaker"] = e.get("speaker", "")
        merged_imgs: List[str] = []
        for row in (best, e):
            for u in row.get("image_urls") or []:
                uu = clean(str(u))
                if uu and uu not in merged_imgs:
                    merged_imgs.append(uu)
        best["image_urls"] = merged_imgs[:12]
        rt1, rt2 = clean(str(best.get("raw_text", ""))), clean(str(e.get("raw_text", "")))
        if len(rt2) > len(rt1):
            best["raw_text"] = e.get("raw_text", "")
    types = sorted({clean(str(x.get("source_type", ""))) for x in grp if clean(str(x.get("source_type", "")))})
    best["merged_source_types"] = types
    return best


def titles_similar(ta: str, tb: str) -> bool:
    a, b = title_key(ta), title_key(tb)
    if not a or not b:
        return False
    if min(len(a), len(b)) >= 6 and (a in b or b in a):
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.82


def merge_fuzzy_duplicate_events(events: List[Dict]) -> List[Dict]:
    """
    Collapse duplicate rows from website + email + Instagram within one per-masjid file.
    Run after strict dedupe_events so only near-duplicates remain.
    """
    if len(events) < 2:
        return events

    orphans: List[Dict] = []
    buckets: Dict[Tuple[str, str, str, str], List[Dict]] = {}
    for e in events:
        src = clean(str(e.get("source", ""))).lower()
        d = clean(str(e.get("date", "")))
        tk = title_key(str(e.get("title", "")))
        if not d or not tk:
            orphans.append(e)
            continue
        tb = normalize_time_bucket(str(e.get("start_time", "")))
        buckets.setdefault((src, d, tk, tb), []).append(e)

    merged: List[Dict] = []
    for grp in buckets.values():
        if len(grp) == 1:
            merged.append(grp[0])
        else:
            merged.append(merge_event_group(grp))

    merged = _fuzzy_second_pass(merged + orphans)
    merged.sort(
        key=lambda x: (x.get("date") or "9999-12-31", x.get("start_time") or "99:99", x.get("title") or "")
    )
    return merged


def _fuzzy_second_pass(rows: List[Dict]) -> List[Dict]:
    """Merge same masjid + date + similar title when venue matches or is blank."""
    n = len(rows)
    used = [False] * n
    out: List[Dict] = []
    for i in range(n):
        if used[i]:
            continue
        base = dict(rows[i])
        used[i] = True
        for j in range(i + 1, n):
            if used[j]:
                continue
            e = rows[j]
            if clean(str(base.get("source", ""))).lower() != clean(str(e.get("source", ""))).lower():
                continue
            if clean(str(base.get("date", ""))) != clean(str(e.get("date", ""))):
                continue
            if not titles_similar(str(base.get("title", "")), str(e.get("title", ""))):
                continue
            vf1, vf2 = venue_fingerprint(base), venue_fingerprint(e)
            if vf1 and vf2 and vf1 != vf2:
                continue
            tb = normalize_time_bucket(str(base.get("start_time", "")))
            te = normalize_time_bucket(str(e.get("start_time", "")))
            if tb and te and tb != te:
                continue
            base = merge_event_group([base, e])
            used[j] = True
        out.append(base)
    return out
