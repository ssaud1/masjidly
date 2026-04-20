#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path("/Users/shaheersaud/Safar")
SOURCE_JSON = ROOT / "target_masjids_events.json"
REPORT_DIR = ROOT / "events_by_masjid" / "_reports"
OUT_JSON = REPORT_DIR / "source_health_dashboard.json"


def clean(value) -> str:
    return str(value or "").strip()


def is_exact_time(value: str) -> bool:
    v = clean(value).lower()
    if not v:
        return False
    if ":" in v and ("am" in v or "pm" in v):
        return True
    if ":" in v and all(p.isdigit() for p in v.split(":")[:2]):
        return True
    return False


def load_rows():
    if not SOURCE_JSON.exists():
        return []
    return json.loads(SOURCE_JSON.read_text(encoding="utf-8"))


def build_report(rows):
    per_source = defaultdict(
        lambda: {
            "total_rows": 0,
            "with_poster": 0,
            "exact_time": 0,
            "inferred_description": 0,
            "latest_event_date": "",
            "duplicate_rows": 0,
        }
    )
    dedupe_seen = set()

    for row in rows:
        source = clean(row.get("source")).lower() or "unknown"
        stat = per_source[source]
        stat["total_rows"] += 1
        if row.get("image_urls"):
            stat["with_poster"] += 1
        if is_exact_time(clean(row.get("start_time"))):
            stat["exact_time"] += 1
        if "check the event page for final details" in clean(row.get("description")).lower():
            stat["inferred_description"] += 1
        row_date = clean(row.get("date"))
        if row_date and (not stat["latest_event_date"] or row_date > stat["latest_event_date"]):
            stat["latest_event_date"] = row_date

        key = (
            source,
            clean(row.get("title")).lower(),
            row_date,
            clean(row.get("start_time")).lower(),
        )
        if key in dedupe_seen:
            stat["duplicate_rows"] += 1
        else:
            dedupe_seen.add(key)

    today = date.today()
    out_rows = []
    for source, stat in sorted(per_source.items()):
        total = stat["total_rows"] or 1
        latest = stat["latest_event_date"]
        stale_days = None
        if latest:
            try:
                stale_days = max(0, (today - date.fromisoformat(latest)).days)
            except ValueError:
                stale_days = None
        out_rows.append(
            {
                "source": source,
                "total_rows": stat["total_rows"],
                "with_poster_pct": round((stat["with_poster"] / total) * 100, 1),
                "exact_time_pct": round((stat["exact_time"] / total) * 100, 1),
                "inferred_description_pct": round((stat["inferred_description"] / total) * 100, 1),
                "duplicate_rows": stat["duplicate_rows"],
                "latest_event_date": latest,
                "stale_data_age_days": stale_days,
            }
        )
    return out_rows


def main() -> None:
    rows = load_rows()
    report = {
        "generated_at": date.today().isoformat(),
        "sources": build_report(rows),
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"source_health_dashboard={OUT_JSON} sources={len(report['sources'])}")


if __name__ == "__main__":
    main()
