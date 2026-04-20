#!/usr/bin/env python3
"""
Print or open NJ masjid websites / optional newsletter URLs from
events_by_masjid/_nj_masjid_manifest.json.

Mailing-list signup is manual (CAPTCHA, double opt-in, and terms of use).
Set NEWSLETTER_EMAIL in your shell as a reminder of which address to enter
into each form; this script does not submit forms or send email.

Examples:
  NEWSLETTER_EMAIL='you@gmail.com' .venv/bin/python open_nj_masjid_outreach.py --dry-run
  .venv/bin/python open_nj_masjid_outreach.py --open websites --delay 1.2
  .venv/bin/python open_nj_masjid_outreach.py --open all --source icpc
"""

from __future__ import annotations

import argparse
import json
import os
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "events_by_masjid" / "_nj_masjid_manifest.json"


def load_manifest() -> Dict[str, Any]:
    if not MANIFEST.exists():
        raise SystemExit(f"Missing manifest: {MANIFEST}")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("masjids"), list):
        raise SystemExit("Invalid manifest: expected object with 'masjids' array")
    return data


def collect_urls(rows: List[Dict[str, Any]], which: str) -> List[str]:
    out: List[str] = []
    for m in rows:
        if which in ("websites", "all"):
            w = (m.get("website") or "").strip()
            if w:
                out.append(w)
        if which in ("events", "all"):
            e = (m.get("events_url") or "").strip()
            if e:
                out.append(e)
        if which in ("instagram", "all"):
            ig = (m.get("instagram") or "").strip()
            if ig:
                out.append(ig)
        if which in ("newsletters", "all"):
            for u in m.get("newsletter_urls") or []:
                uu = (u or "").strip()
                if uu:
                    out.append(uu)
    seen: set = set()
    uniq: List[str] = []
    for u in out:
        if u in seen:
            continue
        seen.add(u)
        uniq.append(u)
    return uniq


def main() -> None:
    ap = argparse.ArgumentParser(description="NJ masjid outreach URLs (manual newsletter signup).")
    ap.add_argument(
        "--open",
        choices=("websites", "events", "instagram", "newsletters", "all"),
        default=None,
        help="Open these URLs in the default browser.",
    )
    ap.add_argument("--source", default="", help="Filter by source key, e.g. icpc")
    ap.add_argument("--delay", type=float, default=0.8, help="Seconds between browser opens.")
    ap.add_argument("--dry-run", action="store_true", help="Print all URL types; do not open browser.")
    args = ap.parse_args()

    if not args.dry_run and args.open is None:
        ap.error("Pass --dry-run or --open <choice>")

    data = load_manifest()
    rows = [m for m in data["masjids"] if isinstance(m, dict)]
    if args.source.strip():
        sk = args.source.strip().lower()
        rows = [m for m in rows if str(m.get("source", "")).lower() == sk]
        if not rows:
            raise SystemExit(f"No masjid with source={args.source!r}")

    email_hint = os.getenv("NEWSLETTER_EMAIL", "").strip()
    if email_hint:
        print(f"NEWSLETTER_EMAIL={email_hint}  (use in signup forms)")
    else:
        print("Tip: export NEWSLETTER_EMAIL='…' to remind yourself which inbox to use.")

    which = "all" if args.dry_run else args.open
    assert which is not None
    urls = collect_urls(rows, which)

    print(f"urls={len(urls)}")
    for u in urls:
        print(u)

    if args.dry_run:
        return

    for u in urls:
        webbrowser.open(u)
        time.sleep(max(0.0, args.delay))


if __name__ == "__main__":
    main()
