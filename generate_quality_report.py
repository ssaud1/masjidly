#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent
TARGET_FUTURE = ROOT / "target_masjids_future_events.json"
REVIEW_DIR = ROOT / "instagram" / "output" / "nj_masjid_events" / "review"

WEAK_TITLE_PATTERNS = [
    re.compile(r"^(when|time|date|where)\b[:\-\s]*", re.I),
    re.compile(r"^\d+\s+likes?,?\s+\d+\s+comments?\b", re.I),
    re.compile(r"^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}$", re.I),
    re.compile(r"\b(link in bio|official rsvp|register now|join us tonight)\b", re.I),
    re.compile(r"^\s*-\s*[a-z0-9_]+.*join us in \d+\s*(hour|hours|hr|min|minutes)\b", re.I),
]

SPEAKER_BAD_PATTERNS = [
    re.compile(r"\b(will be|speaking|talk on|join us|register|rsvp|tonight|follow)\b", re.I),
    re.compile(r"https?://", re.I),
]


def normalize(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def event_poster_url(event: Dict[str, Any]) -> str:
    urls = event.get("image_urls") or []
    if isinstance(urls, str):
        urls = [urls]
    if not isinstance(urls, list):
        return ""
    for raw in urls:
        u = normalize(raw)
        if not u.lower().startswith("http"):
            continue
        low = u.lower()
        if "static.cdninstagram.com/rsrc.php" in low:
            continue
        if "instagram.com/static/images" in low:
            continue
        return u
    return ""


def looks_bad_title(title: str) -> bool:
    s = normalize(title)
    if not s:
        return True
    words = len(s.split())
    if words < 2 or words > 16:
        return True
    low = s.lower()
    if low in {"event", "community event", "untitled event"}:
        return True
    return any(rx.search(s) for rx in WEAK_TITLE_PATTERNS)


def looks_bad_speaker(name: str) -> bool:
    s = normalize(name)
    if not s:
        return False
    if len(s.split()) > 6:
        return True
    return any(rx.search(s) for rx in SPEAKER_BAD_PATTERNS)


def main() -> None:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
    rows: List[Dict[str, Any]] = []
    if TARGET_FUTURE.exists():
        rows = json.loads(TARGET_FUTURE.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        rows = []

    by_source: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"events": 0, "bad_titles": 0, "bad_speakers": 0, "missing_posters": 0}
    )
    bad_title_rows: List[Dict[str, str]] = []
    bad_speaker_rows: List[Dict[str, str]] = []
    missing_poster_rows: List[Dict[str, str]] = []

    for event in rows:
        if not isinstance(event, dict):
            continue
        source = normalize(event.get("source") or "unknown").upper()
        title = normalize(event.get("title"))
        speaker = normalize(event.get("speaker"))
        date = normalize(event.get("date"))
        source_url = normalize(event.get("source_url"))
        poster = event_poster_url(event)
        by_source[source]["events"] += 1

        if looks_bad_title(title):
            by_source[source]["bad_titles"] += 1
            bad_title_rows.append({"source": source, "date": date, "title": title, "url": source_url})
        if looks_bad_speaker(speaker):
            by_source[source]["bad_speakers"] += 1
            bad_speaker_rows.append({"source": source, "date": date, "speaker": speaker, "url": source_url})
        if not poster:
            by_source[source]["missing_posters"] += 1
            missing_poster_rows.append({"source": source, "date": date, "title": title, "url": source_url})

    out_json = REVIEW_DIR / f"quality_report_{stamp}.json"
    out_txt = REVIEW_DIR / f"quality_report_{stamp}.txt"
    payload = {
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "total_events": len(rows),
        "by_source": dict(sorted(by_source.items())),
        "bad_titles": bad_title_rows[:300],
        "bad_speakers": bad_speaker_rows[:300],
        "missing_posters": missing_poster_rows[:300],
    }
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    lines: List[str] = []
    lines.append(f"Total events: {len(rows)}")
    lines.append(f"Masjids/sources: {len(by_source)}")
    lines.append("")
    for source, stats in sorted(by_source.items()):
        lines.append(
            f"{source}: events={stats['events']} | bad_titles={stats['bad_titles']} | "
            f"bad_speakers={stats['bad_speakers']} | missing_posters={stats['missing_posters']}"
        )
    lines.append("")
    lines.append(f"Bad title candidates: {len(bad_title_rows)}")
    lines.append(f"Bad speaker candidates: {len(bad_speaker_rows)}")
    lines.append(f"Missing poster candidates: {len(missing_poster_rows)}")
    lines.append("")
    lines.append("Top bad titles:")
    for row in bad_title_rows[:40]:
        lines.append(f"- {row['source']} {row['date']} :: {row['title']}")
    lines.append("")
    lines.append("Top bad speakers:")
    for row in bad_speaker_rows[:40]:
        lines.append(f"- {row['source']} {row['date']} :: {row['speaker']}")
    lines.append("")
    lines.append("Top missing posters:")
    for row in missing_poster_rows[:40]:
        lines.append(f"- {row['source']} {row['date']} :: {row['title']}")

    out_txt.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    print(f"[quality] json={out_json}")
    print(f"[quality] txt={out_txt}")


if __name__ == "__main__":
    main()

