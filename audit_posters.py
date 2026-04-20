#!/usr/bin/env python3
from __future__ import annotations

from ingest_masjid_emails import audit_source_posters

SOURCES = ["mcgp", "mcmc", "iceb", "darul_islah", "nbic"]


def main() -> None:
    for src in SOURCES:
        audit_source_posters(src)
        print(f"poster_audit={src} done")


if __name__ == "__main__":
    main()

