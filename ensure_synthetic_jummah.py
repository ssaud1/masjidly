"""Guarantee a weekly Jumu'ah event for every NJ masjid in the pipeline.

Reads `events_by_masjid/_nj_masjid_manifest.json` for the full source list, then
ensures that `target_masjids_events.json` (and the future-events sibling file)
contain at least N weeks of `category == "jummah"` rows per masjid. Any masjid
already providing a future Jumu'ah (either from a scraped site, Instagram, or
email) is left untouched.

Run directly, or `from ensure_synthetic_jummah import ensure_synthetic_jummah`.

Wired into `safar_daily_pipeline.py` between the IG scrape and enrichment so
every masjid has at least weekly Jumu'ah coverage even if upstream sources fail.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional

ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "events_by_masjid" / "_nj_masjid_manifest.json"
DEFAULT_TARGET_FILES = [
    ROOT / "target_masjids_events.json",
    ROOT / "target_masjids_future_events.json",
]

DEFAULT_WEEKS = 12
DEFAULT_START_TIME = "13:30"
DEFAULT_END_TIME = "14:15"

# Per-masjid overrides for Jumu'ah start/end (HH:MM, 24h). Add rows as confirmed.
JUMMAH_TIME_OVERRIDES: Dict[str, Dict[str, str]] = {
    "mcgp": {"start_time": "13:30", "end_time": "14:15"},
    "mcmc": {"start_time": "13:30", "end_time": "14:15"},
    "iscj": {"start_time": "13:15", "end_time": "14:15"},
    "icpc": {"start_time": "13:30", "end_time": "14:15"},
    "iceb": {"start_time": "13:30", "end_time": "14:15"},
    "nbic": {"start_time": "13:30", "end_time": "14:15"},
    "alfalah": {"start_time": "13:30", "end_time": "14:15"},
    "darul_islah": {"start_time": "13:15", "end_time": "14:00"},
    "masjid_al_wali": {"start_time": "13:30", "end_time": "14:15"},
    "icsj": {"start_time": "13:30", "end_time": "14:15"},
    "masjid_muhammad_newark": {"start_time": "13:30", "end_time": "14:15"},
    "icuc": {"start_time": "13:30", "end_time": "14:15"},
    "ismc": {"start_time": "13:30", "end_time": "14:15"},
    "mcnj": {"start_time": "13:30", "end_time": "14:15"},
    "icna_nj": {"start_time": "13:30", "end_time": "14:15"},
    "jmic": {"start_time": "13:30", "end_time": "14:15"},
    "icmc": {"start_time": "13:30", "end_time": "14:15"},
    "icoc": {"start_time": "13:30", "end_time": "14:15"},
    "bayonne_mc": {"start_time": "13:30", "end_time": "14:15"},
    "hudson_ic": {"start_time": "13:30", "end_time": "14:15"},
    "clifton_ic": {"start_time": "13:30", "end_time": "14:15"},
    "isbc": {"start_time": "13:30", "end_time": "14:15"},
    "mcjc": {"start_time": "13:30", "end_time": "14:15"},
    "waarith": {"start_time": "13:30", "end_time": "14:15"},
}

JUMMAH_TITLE = "Jumu'ah Prayer & Khutbah"
JUMMAH_PATTERN = re.compile(r"\b(jumu|jumma|jummah|khutbah)\b", re.IGNORECASE)


def _load_manifest() -> List[Dict]:
    # Manifest is typically created by the Instagram scraper. When the pipeline
    # runs without IG (CI smoke tests, fast mode) the file may not exist yet —
    # treat that as "no manifest-based masjids" rather than crashing the whole
    # pipeline.
    if not MANIFEST_PATH.exists():
        print(f"[ensure_synthetic_jummah] manifest missing at {MANIFEST_PATH}; continuing with empty list")
        return []
    with MANIFEST_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("masjids", [])


def _next_friday(today: dt.date) -> dt.date:
    # weekday(): Monday=0 ... Sunday=6, so Friday=4.
    delta_days = (4 - today.weekday()) % 7
    return today + dt.timedelta(days=delta_days)


def _is_future_jummah(row: Dict, source: str, horizon_days: int) -> bool:
    if str(row.get("source", "")).strip().lower() != source.lower():
        return False
    date_str = str(row.get("date", "")).strip()
    if not date_str:
        return False
    today = dt.date.today()
    try:
        row_date = dt.date.fromisoformat(date_str)
    except ValueError:
        return False
    if row_date < today or (row_date - today).days > horizon_days:
        return False
    category = str(row.get("category", "")).lower()
    title = str(row.get("title", "")).lower()
    if category == "jummah":
        return True
    return bool(JUMMAH_PATTERN.search(f"{title} {category}"))


def _build_synth_row(masjid: Dict, date: dt.date) -> Dict:
    source = masjid["source"]
    times = JUMMAH_TIME_OVERRIDES.get(source, {"start_time": DEFAULT_START_TIME, "end_time": DEFAULT_END_TIME})
    website = masjid.get("website") or masjid.get("events_url") or ""
    return {
        "source": source,
        "source_type": "synthetic_jummah",
        "source_url": website,
        "title": JUMMAH_TITLE,
        "description": (
            f"Weekly Jumu'ah prayer and khutbah at {masjid.get('name', source)}. "
            "Baseline entry generated to guarantee weekly coverage — confirm exact time "
            "with the masjid's official schedule, as timings shift with the seasons."
        ),
        "date": date.isoformat(),
        "start_time": times.get("start_time", DEFAULT_START_TIME),
        "end_time": times.get("end_time", DEFAULT_END_TIME),
        "location_name": masjid.get("name", ""),
        "address": "",
        "city": "",
        "state": "NJ",
        "zip": "",
        "category": "jummah",
        "audience": "all",
        "organizer": masjid.get("name", ""),
        "rsvp_link": "",
        "image_urls": [],
        "raw_text": "Synthetic weekly Jumu'ah baseline (ensure_synthetic_jummah.py).",
        "confidence": 0.6,
        "speaker": "",
        "poster_ocr_text": "",
        "transparency": "synthetic_weekly",
        "event_uid": f"{source}-jummah-{date.isoformat()}",
    }


def ensure_synthetic_jummah(
    target_paths: Optional[Iterable[Path]] = None,
    weeks: int = DEFAULT_WEEKS,
) -> Dict[str, int]:
    """Mutate-in-place each target file, adding missing Jumu'ah rows.

    Returns a ``{source: rows_added}`` mapping summed across all files.
    """

    paths = list(target_paths) if target_paths else list(DEFAULT_TARGET_FILES)
    manifest = _load_manifest()
    if not manifest:
        print("[ensure_synthetic_jummah] No masjids found in manifest; nothing to do.")
        return {}

    today = dt.date.today()
    horizon_days = weeks * 7
    total_added: Dict[str, int] = {}

    for target in paths:
        if not target.exists():
            print(f"[ensure_synthetic_jummah] skip missing {target.name}")
            continue
        try:
            rows = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"[ensure_synthetic_jummah] WARN: could not parse {target.name}: {exc}")
            continue
        if not isinstance(rows, list):
            print(f"[ensure_synthetic_jummah] skip {target.name}: expected list, got {type(rows).__name__}")
            continue

        seen_uids = {str(r.get("event_uid", "")).strip() for r in rows if r.get("event_uid")}
        added_this_file = 0

        for masjid in manifest:
            source = masjid.get("source")
            if not source:
                continue
            already_has_future = any(_is_future_jummah(r, source, horizon_days) for r in rows)
            if already_has_future:
                continue

            next_friday = _next_friday(today)
            for i in range(weeks):
                date = next_friday + dt.timedelta(days=7 * i)
                synth = _build_synth_row(masjid, date)
                if synth["event_uid"] in seen_uids:
                    continue
                rows.append(synth)
                seen_uids.add(synth["event_uid"])
                added_this_file += 1
                total_added[source] = total_added.get(source, 0) + 1

        if added_this_file:
            target.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[ensure_synthetic_jummah] {target.name}: added {added_this_file} rows")
        else:
            print(f"[ensure_synthetic_jummah] {target.name}: no rows needed")

    if total_added:
        rollup = ", ".join(f"{s}+{n}" for s, n in sorted(total_added.items()))
        print(f"[ensure_synthetic_jummah] Jumu'ah coverage filled: {rollup}")
    else:
        print("[ensure_synthetic_jummah] All masjids already have future Jumu'ah rows.")
    return total_added


def main() -> None:
    ensure_synthetic_jummah()


if __name__ == "__main__":
    main()
