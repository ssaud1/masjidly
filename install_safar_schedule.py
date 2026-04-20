#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path("/Users/shaheersaud/Safar")
PY = ROOT / ".venv" / "bin" / "python"
PIPELINE = ROOT / "safar_daily_pipeline.py"
LOG = ROOT / "events_by_masjid" / "_reports" / "pipeline_cron.log"

CRON_BEGIN = "# BEGIN SAFAR_PIPELINE"
CRON_END = "# END SAFAR_PIPELINE"


def cron_line(hours_csv: str, fast_mode: bool) -> str:
    fast_prefix = 'SAFAR_FAST_MODE=1 ' if fast_mode else 'SAFAR_FAST_MODE=0 '
    return (
        f"0 {hours_csv} * * * "
        f'cd "{ROOT}" && {fast_prefix}"{PY}" "{PIPELINE}" >> "{LOG}" 2>&1'
    )


def read_crontab() -> str:
    proc = subprocess.run(
        ["crontab", "-l"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        # No crontab yet is normal.
        return ""
    return proc.stdout


def strip_managed_block(text: str) -> str:
    lines = text.splitlines()
    out = []
    in_block = False
    for ln in lines:
        if ln.strip() == CRON_BEGIN:
            in_block = True
            continue
        if ln.strip() == CRON_END:
            in_block = False
            continue
        if not in_block:
            out.append(ln)
    return "\n".join(out).strip()


def install(fast_hours_csv: str, full_hour: str) -> None:
    existing = read_crontab()
    base = strip_managed_block(existing)
    managed = "\n".join(
        [
            CRON_BEGIN,
            cron_line(fast_hours_csv, fast_mode=True),
            cron_line(full_hour, fast_mode=False),
            CRON_END,
        ]
    )
    new_text = (base + "\n\n" + managed).strip() + "\n"
    subprocess.run(["crontab", "-"], input=new_text, text=True, check=True)
    print("Installed Masjidly pipeline cron schedule.")
    print(f"Fast hours: {fast_hours_csv} (minute 0)")
    print(f"Full hour: {full_hour} (minute 0)")
    print(f"Log: {LOG}")


def remove() -> None:
    existing = read_crontab()
    if not existing:
        print("No crontab found. Nothing to remove.")
        return
    base = strip_managed_block(existing)
    new_text = (base.strip() + "\n") if base.strip() else ""
    subprocess.run(["crontab", "-"], input=new_text, text=True, check=True)
    print("Removed Safar managed cron schedule.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install/remove Masjidly fast/full cron schedule.")
    parser.add_argument(
        "--fast-hours",
        default="6,14,22",
        help="Comma-separated hours (24h) for fast mode runs. Default: 6,14,22",
    )
    parser.add_argument(
        "--full-hour",
        default="2",
        help="Hour (24h) for full mode nightly run. Default: 2",
    )
    parser.add_argument("--remove", action="store_true", help="Remove managed Safar cron block.")
    args = parser.parse_args()

    if args.remove:
        remove()
        return

    if not PY.exists():
        print(f"Virtualenv python missing: {PY}", file=sys.stderr)
        sys.exit(1)
    if not PIPELINE.exists():
        print(f"Pipeline script missing: {PIPELINE}", file=sys.stderr)
        sys.exit(1)
    install(args.fast_hours, args.full_hour)


if __name__ == "__main__":
    main()

