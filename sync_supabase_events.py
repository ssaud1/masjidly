#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import base64
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

import requests

ROOT = Path("/Users/shaheersaud/Safar")
SOURCE_JSON = ROOT / "target_masjids_events.json"
REPORT_DIR = ROOT / "events_by_masjid" / "_reports"
DATE_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def clean(s: str) -> str:
    return " ".join((s or "").split()).strip()


def normalize_title(s: str) -> str:
    t = clean(s).lower()
    t = re.sub(r"[’'`\"]", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def normalize_time(s: str) -> str:
    t = clean(s).lower()
    if not t:
        return ""
    m_ampm = re.match(r"^(\d{1,2}):(\d{2})\s*(am|pm)$", t)
    if m_ampm:
        h = int(m_ampm.group(1)) % 12
        if m_ampm.group(3) == "pm":
            h += 12
        return f"{h:02d}:{m_ampm.group(2)}"
    m_hhmm = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if m_hhmm:
        return f"{int(m_hhmm.group(1)):02d}:{m_hhmm.group(2)}"
    return t


def infer_supabase_url_from_jwt(token: str) -> str:
    t = clean(token)
    if t.count(".") < 2:
        return ""
    try:
        payload_b64 = t.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8"))
        iss = clean(str(payload.get("iss", "")))
        if iss.startswith("https://") and ".supabase.co" in iss:
            return iss.split("/auth/", 1)[0]
        ref = clean(str(payload.get("ref", "")))
        if ref:
            return f"https://{ref}.supabase.co"
    except Exception:
        return ""
    return ""


def load_json(path: Path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def event_uid(e: Dict) -> str:
    parts = [
        clean(str(e.get("source", ""))).lower(),
        normalize_title(str(e.get("title", ""))),
        clean(str(e.get("date", ""))),
        normalize_time(str(e.get("start_time", ""))),
        clean(str(e.get("source_url", ""))).lower(),
    ]
    raw = "|".join(parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def validate_event_for_sync(e: Dict) -> Tuple[bool, str]:
    """Reject malformed rows before Supabase upsert; keeps the DB contract clean."""
    title = clean(str(e.get("title", "")))
    if len(title) < 2:
        return False, "title_too_short"
    d = clean(str(e.get("date", "")))
    if not d or not DATE_ISO_RE.match(d):
        return False, "bad_date"
    conf = float(e.get("confidence", 0.0) or 0.0)
    min_conf = float(os.environ.get("SAFAR_SYNC_MIN_CONFIDENCE", "0") or 0.0)
    if min_conf > 0 and conf < min_conf:
        return False, "below_min_confidence"
    return True, ""


def append_quarantine(rows: List[Dict], batch_id: str) -> None:
    if not rows:
        return
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / "supabase_quarantine.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        for e in rows:
            line = {
                "batch_id": batch_id,
                "reason": clean(str(e.get("_reject_reason", "unknown"))),
                "source": clean(str(e.get("source", ""))),
                "title": clean(str(e.get("title", "")))[:200],
                "date": clean(str(e.get("date", ""))),
            }
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")


def to_row(e: Dict, batch_id: str) -> Dict:
    d = clean(str(e.get("date", "")))
    is_future = bool(d and d >= datetime.now().date().isoformat())
    return {
        "event_uid": event_uid(e),
        "source": clean(str(e.get("source", ""))),
        "source_type": clean(str(e.get("source_type", ""))),
        "source_url": clean(str(e.get("source_url", ""))),
        "title": clean(str(e.get("title", ""))),
        "description": clean(str(e.get("description", ""))),
        "date": d or None,
        "start_time": clean(str(e.get("start_time", ""))),
        "end_time": clean(str(e.get("end_time", ""))),
        "location_name": clean(str(e.get("location_name", ""))),
        "address": clean(str(e.get("address", ""))),
        "city": clean(str(e.get("city", ""))),
        "state": clean(str(e.get("state", ""))),
        "zip": clean(str(e.get("zip", ""))),
        "category": clean(str(e.get("category", ""))),
        "audience": clean(str(e.get("audience", ""))),
        "organizer": clean(str(e.get("organizer", ""))),
        "rsvp_link": clean(str(e.get("rsvp_link", ""))),
        "image_urls": e.get("image_urls", []) or [],
        "image_review_urls": e.get("image_review_urls", []) or [],
        "speaker": clean(str(e.get("speaker", ""))),
        "confidence": float(e.get("confidence", 0.0) or 0.0),
        "is_future": is_future,
        "sync_batch_id": batch_id,
    }


def upsert_batch(base_url: str, headers: Dict[str, str], rows: List[Dict]) -> None:
    url = f"{base_url}/rest/v1/events"
    h = dict(headers)
    h["Prefer"] = "resolution=merge-duplicates,return=minimal"
    r = requests.post(url, headers=h, params={"on_conflict": "event_uid"}, json=rows, timeout=60)
    if r.status_code not in (200, 201, 204):
        raise RuntimeError(f"Supabase upsert failed: {r.status_code} {r.text[:400]}")


def cleanup_stale(base_url: str, headers: Dict[str, str], batch_id: str) -> None:
    url = f"{base_url}/rest/v1/events"
    # Delete rows not touched by this sync batch.
    r = requests.delete(url, headers=headers, params={"sync_batch_id": f"neq.{batch_id}"}, timeout=60)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"Supabase cleanup failed: {r.status_code} {r.text[:400]}")


def main() -> None:
    # Support both standard env names and user's existing lowercase names.
    supabase_url = clean(
        os.getenv("SUPABASE_URL", "")
        or os.getenv("supabaseurl", "")
    )
    service_key = clean(
        os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        or os.getenv("servicerole", "")
        or os.getenv("supabasekey", "")
    )
    # If user accidentally stored URL in supabasekey, accept it.
    if not supabase_url and clean(os.getenv("supabasekey", "")).startswith("http"):
        supabase_url = clean(os.getenv("supabasekey", ""))
    if not supabase_url:
        supabase_url = infer_supabase_url_from_jwt(os.getenv("servicerole", "")) or infer_supabase_url_from_jwt(
            os.getenv("supabasekey", "")
        )
    if not supabase_url or not service_key:
        print("supabase_sync=skipped missing Supabase URL or service role key")
        return

    events = load_json(SOURCE_JSON)
    batch_id = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    rows = []
    seen_keys = set()
    quarantined: List[Dict] = []
    for e in events:
        ok, reason = validate_event_for_sync(e)
        if not ok:
            quarantined.append({**e, "_reject_reason": reason})
            continue
        row = to_row(e, batch_id)
        # Keep DB clean: require minimum event identity fields.
        if not row.get("date"):
            quarantined.append({**e, "_reject_reason": "missing_date_row"})
            continue
        if not clean(str(row.get("title", ""))):
            quarantined.append({**e, "_reject_reason": "missing_title_row"})
            continue
        dedupe_key = (
            clean(str(row.get("source", ""))).lower(),
            normalize_title(str(row.get("title", ""))),
            clean(str(row.get("date", ""))),
            normalize_time(str(row.get("start_time", ""))),
        )
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        rows.append(row)

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    chunk = 500
    for i in range(0, len(rows), chunk):
        upsert_batch(supabase_url, headers, rows[i : i + chunk])
    cleanup_stale(supabase_url, headers, batch_id)
    if quarantined:
        append_quarantine(quarantined, batch_id)
        print(f"supabase_sync=quarantined={len(quarantined)} (see events_by_masjid/_reports/supabase_quarantine.jsonl)")
    summary = {
        "batch_id": batch_id,
        "rows_upserted": len(rows),
        "rows_quarantined": len(quarantined),
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    sp = REPORT_DIR / f"supabase_sync_summary_{batch_id}.json"
    sp.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"supabase_sync=ok rows={len(rows)} batch={batch_id} summary={sp.name}")


if __name__ == "__main__":
    main()

