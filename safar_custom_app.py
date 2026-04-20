#!/usr/bin/env python3
# Requirements:
#   pip install flask
#
# Run:
#   .venv/bin/python safar_custom_app.py
#
# App:
#   http://127.0.0.1:5060

from __future__ import annotations

import json
import hashlib
import math
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)

# Railway / Heroku-style platforms set PORT; fall back to APP_PORT for local dev.
PORT = int(os.getenv("PORT") or os.getenv("APP_PORT", "5060"))
HOST = os.getenv("APP_HOST", "0.0.0.0")

# Project root — used to resolve bundled data files regardless of CWD
# (gunicorn may run from a different working directory on the host).
PROJECT_ROOT = Path(__file__).resolve().parent

# Allow DB_PATH to be overridden via env so Railway can mount a persistent
# volume (e.g. DB_PATH=/data/masjidly_app.db) without code changes.
DB_PATH = Path(os.getenv("DB_PATH") or (PROJECT_ROOT / "masjidly_app.db"))
try:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

DATA_FILES = [
    str(PROJECT_ROOT / "target_masjids_events.json"),
    str(PROJECT_ROOT / "target_masjids_future_events.json"),
]

MASJID_COORDS: Dict[str, Tuple[float, float]] = {
    "iceb": (40.4308, -74.4122),
    "mcmc": (40.5509, -74.4746),
    "iscj": (40.3938, -74.5460),
    "icpc": (40.9061, -74.1637),
    "mcgp": (40.2937, -74.6435),
    "darul_islah": (40.8895, -74.0148),
    "nbic": (40.4711, -74.4570),
    "alfalah": (40.5589, -74.6267),
    "masjid_al_wali": (40.5944, -74.3547),
    "icsj": (39.8516, -74.9746),
    "masjid_muhammad_newark": (40.7380, -74.2142),
    "icuc": (40.6955, -74.2892),
    "ismc": (40.3895, -74.1375),
    "mcnj": (40.5412, -74.3160),
    "icna_nj": (40.4845, -74.5280),
    "jmic": (40.9042, -74.4110),
    "icmc": (40.8945, -74.5128),
    "icoc": (39.9872, -74.2215),
    "bayonne_mc": (40.6583, -74.1118),
    "hudson_ic": (40.7280, -74.0420),
    "clifton_ic": (40.8756, -74.1554),
    "isbc": (40.6411, -74.5486),
    "mcjc": (40.7252, -74.0692),
    "waarith": (40.7410, -74.2140),
}

NOISE_TITLES = {
    "prayer schedule",
    "contact info",
    "quick links",
    "related events",
    "details",
    "event",
}


def db_conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db() -> None:
    con = db_conn()
    cur = con.cursor()
    cur.execute(
        """
        create table if not exists users (
          id integer primary key autoincrement,
          email text not null unique,
          password_hash text not null,
          oauth_provider text not null default '',
          role text not null default 'user',
          created_at text not null
        )
        """
    )
    cur.execute(
        """
        create table if not exists sessions (
          token text primary key,
          user_id integer not null,
          expires_at text not null,
          created_at text not null,
          foreign key(user_id) references users(id)
        )
        """
    )
    cur.execute(
        """
        create table if not exists profiles (
          user_id integer primary key,
          favorite_sources text not null default '[]',
          audience_filter text not null default 'all',
          radius integer not null default 35,
          onboarding_done integer not null default 0,
          home_lat real,
          home_lon real,
          expo_push_token text not null default '',
          updated_at text not null,
          foreign key(user_id) references users(id)
        )
        """
    )
    cur.execute(
        """
        create table if not exists notification_settings (
          user_id integer primary key,
          new_event_followed integer not null default 1,
          tonight_after_maghrib integer not null default 1,
          rsvp_reminders integer not null default 1,
          updated_at text not null,
          foreign key(user_id) references users(id)
        )
        """
    )
    cur.execute(
        """
        create table if not exists moderation_reports (
          id integer primary key autoincrement,
          event_uid text not null,
          issue_type text not null,
          details text not null default '',
          status text not null default 'open',
          reported_by integer,
          created_at text not null,
          updated_at text not null
        )
        """
    )
    try:
        cur.execute("alter table users add column role text not null default 'user'")
    except sqlite3.OperationalError:
        # column already exists in initialized databases
        pass

    # --- new feature tables (roadmap items 2/18/21/23/24/31/40/46/49) ---
    cur.execute(
        """
        create table if not exists rsvps (
          id integer primary key autoincrement,
          user_id integer not null,
          event_uid text not null,
          status text not null,
          created_at text not null,
          unique(user_id, event_uid)
        )
        """
    )
    cur.execute("create index if not exists rsvps_event_idx on rsvps(event_uid)")
    cur.execute("create index if not exists rsvps_user_idx on rsvps(user_id)")
    cur.execute(
        """
        create table if not exists follows (
          id integer primary key autoincrement,
          follower_id integer not null,
          followee_id integer not null,
          created_at text not null,
          unique(follower_id, followee_id)
        )
        """
    )
    cur.execute(
        """
        create table if not exists reflections (
          id integer primary key autoincrement,
          user_id integer not null,
          event_uid text not null,
          rating integer not null default 0,
          text text not null default '',
          visibility text not null default 'public',
          created_at text not null
        )
        """
    )
    cur.execute("create index if not exists reflections_event_idx on reflections(event_uid)")
    cur.execute(
        """
        create table if not exists iqama (
          source text not null,
          prayer text not null,
          iqama_time text not null,
          jumuah_times text not null default '[]',
          set_by integer,
          updated_at text not null,
          primary key (source, prayer)
        )
        """
    )
    cur.execute(
        """
        create table if not exists correction_votes (
          id integer primary key autoincrement,
          event_uid text not null,
          user_id integer,
          weight integer not null default 1,
          reason text not null default '',
          created_at text not null
        )
        """
    )
    cur.execute("create index if not exists correction_votes_event_idx on correction_votes(event_uid)")
    cur.execute(
        """
        create table if not exists passport_stamps (
          id integer primary key autoincrement,
          user_id integer not null,
          source text not null,
          created_at text not null,
          unique(user_id, source)
        )
        """
    )
    cur.execute(
        """
        create table if not exists admin_masjids (
          id integer primary key autoincrement,
          user_id integer not null,
          source text not null,
          verified integer not null default 0,
          verification_token text not null default '',
          created_at text not null,
          unique(user_id, source)
        )
        """
    )
    cur.execute(
        """
        create table if not exists event_overrides (
          event_uid text primary key,
          fields_json text not null,
          edited_by integer,
          updated_at text not null
        )
        """
    )
    cur.execute(
        """
        create table if not exists event_views (
          id integer primary key autoincrement,
          event_uid text not null,
          user_id integer,
          created_at text not null
        )
        """
    )
    cur.execute("create index if not exists event_views_event_idx on event_views(event_uid)")

    con.commit()
    con.close()


def now_iso() -> str:
    return datetime.utcnow().isoformat()


def bearer_token() -> str:
    auth = clean(request.headers.get("Authorization", ""))
    if auth.lower().startswith("bearer "):
        return clean(auth.split(" ", 1)[1])
    return ""


def auth_user() -> Optional[sqlite3.Row]:
    token = bearer_token()
    if not token:
        return None
    con = db_conn()
    try:
        row = con.execute(
            """
            select u.id, u.email, u.oauth_provider, u.role, s.expires_at
            from sessions s
            join users u on u.id = s.user_id
            where s.token = ?
            """,
            (token,),
        ).fetchone()
        if not row:
            return None
        if clean(row["expires_at"]) < now_iso():
            con.execute("delete from sessions where token = ?", (token,))
            con.commit()
            return None
        return row
    finally:
        con.close()


def is_admin(user: Optional[sqlite3.Row]) -> bool:
    if not user:
        return False
    return clean(str(user["role"] or "")).lower() == "admin"


def ensure_profile(user_id: int, con: Optional[sqlite3.Connection] = None) -> None:
    owns_connection = con is None
    con = con or db_conn()
    try:
        existing = con.execute("select user_id from profiles where user_id = ?", (user_id,)).fetchone()
        if not existing:
            con.execute(
                """
                insert into profiles (user_id, favorite_sources, audience_filter, radius, onboarding_done, updated_at)
                values (?, '[]', 'all', 35, 0, ?)
                """,
                (user_id, now_iso()),
            )
        existing_n = con.execute("select user_id from notification_settings where user_id = ?", (user_id,)).fetchone()
        if not existing_n:
            con.execute(
                """
                insert into notification_settings (user_id, new_event_followed, tonight_after_maghrib, rsvp_reminders, updated_at)
                values (?, 1, 1, 1, ?)
                """,
                (user_id, now_iso()),
            )
        con.commit()
    finally:
        if owns_connection:
            con.close()


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def normalize_time(value: str) -> str:
    t = clean(value).lower()
    if not t:
        return ""
    m_ampm = re.match(r"^(\d{1,2}):(\d{2})\s*(am|pm)$", t)
    if m_ampm:
        h = int(m_ampm.group(1)) % 12
        if m_ampm.group(3) == "pm":
            h += 12
        return f"{h:02d}:{m_ampm.group(2)}"
    m_24h = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if m_24h:
        return f"{int(m_24h.group(1)):02d}:{m_24h.group(2)}"
    return t


def normalize_title(value: str) -> str:
    t = clean(value).lower()
    t = re.sub(r"[’'`\"]", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def event_uid_for(source: str, title: str, event_date: str, start_time: str, source_url: str) -> str:
    raw = "|".join(
        [
            clean(source).lower(),
            normalize_title(title),
            clean(event_date),
            normalize_time(start_time),
            clean(source_url).lower(),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def deep_link_for(event_uid: str) -> Dict[str, str]:
    uid = clean(event_uid)
    return {
        "app": f"masjidly://event/{uid}",
        "web": f"https://masjidly.app/event/{uid}",
    }


def parse_iso_date(value: str) -> Optional[date]:
    s = clean(value)
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def normalize_image_urls(raw) -> List[str]:
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, str):
        s = clean(raw)
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                values = parsed if isinstance(parsed, list) else [s]
            except Exception:
                values = [s]
        else:
            values = [s] if s else []
    else:
        values = []

    out: List[str] = []
    for item in values:
        u = clean(str(item)).replace("\\/", "/")
        if u.startswith("//"):
            u = "https:" + u
        if u.startswith("http://") or u.startswith("https://"):
            low = u.lower()
            if "logo" in low or "icon" in low or "favicon" in low:
                continue
            if u not in out:
                out.append(u)
    return out


def haversine_miles(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    r = 3958.8
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def pick_data_file() -> Path:
    for fp in DATA_FILES:
        p = Path(fp)
        if p.exists():
            return p
    raise FileNotFoundError(f"No dataset found. Expected one of: {', '.join(DATA_FILES)}")


def load_events() -> List[Dict]:
    path = pick_data_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    events: List[Dict] = []
    for e in raw:
        title = clean(e.get("title", ""))
        if not title or title.lower() in NOISE_TITLES:
            continue
        if re.fullmatch(r"\d+\s+event[s]?,\s*\d+", title.lower()):
            continue
        d = parse_iso_date(e.get("date", ""))
        source = clean(e.get("source", ""))
        source_url = clean(e.get("source_url", ""))
        event_uid = clean(e.get("event_uid", "")) or event_uid_for(
            source,
            title,
            clean(e.get("date", "")),
            clean(e.get("start_time", "")),
            source_url,
        )
        address = clean(e.get("address", ""))
        merged_types = e.get("merged_source_types")
        if not isinstance(merged_types, list):
            merged_types = []
        merged_types = [clean(x).lower() for x in merged_types if clean(x)]
        st_primary = clean(e.get("source_type", "")).lower()
        events.append(
            {
                "event_uid": event_uid,
                "source": source,
                "source_type": st_primary,
                "merged_source_types": merged_types,
                "title": title,
                "description": clean(e.get("description", "")),
                "date": clean(e.get("date", "")),
                "parsed_date": d.isoformat() if d else "",
                "start_time": clean(e.get("start_time", "")),
                "end_time": clean(e.get("end_time", "")),
                "location_name": clean(e.get("location_name", "")),
                "address": address,
                "city": clean(e.get("city", "")),
                "speaker": clean(e.get("speaker", "")),
                "category": clean(e.get("category", "")),
                "audience": clean(e.get("audience", "")),
                "rsvp_link": clean(e.get("rsvp_link", "")),
                "source_url": source_url,
                "image_urls": normalize_image_urls(e.get("image_urls", [])),
                "confidence": float(e.get("confidence", 0) or 0.0),
                "deep_link": deep_link_for(event_uid),
                "map_link": f"https://maps.google.com/?q={address.replace(' ', '+')}" if address else "",
            }
        )
    events.sort(key=lambda x: (x["parsed_date"] or "9999-12-31", x["start_time"] or "99:99", x["title"]))
    return events


EVENTS_CACHE = load_events()
try:
    EVENTS_CACHE_MTIME = pick_data_file().stat().st_mtime
except Exception:
    EVENTS_CACHE_MTIME = 0.0
init_db()


def refresh_events_cache_if_needed(force: bool = False) -> None:
    global EVENTS_CACHE, EVENTS_CACHE_MTIME
    try:
        data_path = pick_data_file()
        mtime = data_path.stat().st_mtime
        if force or mtime > EVENTS_CACHE_MTIME:
            EVENTS_CACHE = load_events()
            apply_event_overrides(EVENTS_CACHE)
            EVENTS_CACHE_MTIME = mtime
    except Exception:
        # keep serving existing in-memory cache on transient file errors
        return


def filter_events(
    *,
    start_date: date,
    end_date: date,
    sources: List[str],
    query: str,
    reference_source: str,
    radius_miles: int,
    user_lat: Optional[float] = None,
    user_lon: Optional[float] = None,
) -> List[Dict]:
    src_filter = set(sources)
    nearby_sources = set(src_filter)
    if user_lat is not None and user_lon is not None:
        ref = (float(user_lat), float(user_lon))
        nearby_sources = {
            s
            for s in src_filter
            if s in MASJID_COORDS and haversine_miles(ref, MASJID_COORDS[s]) <= radius_miles
        }
        # Do not drop masjids that have no map pin yet — still show their events when selected.
        for s in src_filter:
            if s not in MASJID_COORDS:
                nearby_sources.add(s)
        if not nearby_sources:
            nearby_sources = src_filter
    elif reference_source in MASJID_COORDS:
        ref = MASJID_COORDS[reference_source]
        nearby_sources = {
            s
            for s in src_filter
            if s in MASJID_COORDS and haversine_miles(ref, MASJID_COORDS[s]) <= radius_miles
        }
        for s in src_filter:
            if s not in MASJID_COORDS:
                nearby_sources.add(s)
        if not nearby_sources:
            nearby_sources = src_filter

    q = clean(query).lower()
    out: List[Dict] = []
    for e in EVENTS_CACHE:
        d = parse_iso_date(e.get("date", ""))
        if not d:
            continue
        if d < start_date or d > end_date:
            continue
        src = e.get("source", "")
        if src_filter and src not in src_filter:
            continue
        if nearby_sources and src not in nearby_sources:
            continue
        if q:
            hay = " ".join(
                [
                    e.get("title", ""),
                    e.get("description", ""),
                    e.get("speaker", ""),
                    e.get("category", ""),
                    e.get("audience", ""),
                ]
            ).lower()
            if q not in hay:
                continue
        if user_lat is not None and user_lon is not None and src in MASJID_COORDS:
            e = dict(e)
            e["distance_miles"] = round(haversine_miles((float(user_lat), float(user_lon)), MASJID_COORDS[src]), 1)
        out.append(e)

    deduped: List[Dict] = []
    seen = set()
    for e in out:
        key = (
            clean(e.get("source", "")).lower(),
            normalize_title(e.get("title", "")),
            clean(e.get("date", "")),
            normalize_time(e.get("start_time", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(e)
    deduped.sort(key=lambda x: (x.get("date", ""), normalize_time(x.get("start_time", "")) or "99:99", x.get("title", "")))
    return deduped


def apply_event_overrides(events: List[Dict]) -> None:
    """Merge admin-edited fields from event_overrides into the cached events list (#46)."""
    try:
        con = db_conn()
        rows = con.execute("select event_uid, fields_json from event_overrides").fetchall()
        con.close()
    except Exception:
        return
    by_uid = {clean(r["event_uid"]): r["fields_json"] for r in rows}
    if not by_uid:
        return
    for e in events:
        uid = clean(e.get("event_uid", ""))
        if uid in by_uid:
            try:
                patch = json.loads(by_uid[uid])
                e.update(patch)
            except Exception:
                pass


def enrich_events(events: List[Dict]) -> List[Dict]:
    """Attach freshness + topics + correction flag summary to every event. Safe to call on filtered list."""
    if not events:
        return events
    uids = [clean(e.get("event_uid", "")) for e in events if e.get("event_uid")]
    vote_map: Dict[str, Dict] = {}
    if uids:
        try:
            con = db_conn()
            placeholders = ",".join("?" for _ in uids)
            rows = con.execute(
                f"""
                select event_uid,
                       coalesce(sum(weight),0) as score,
                       count(*) as n
                from correction_votes where event_uid in ({placeholders}) group by event_uid
                """,
                tuple(uids),
            ).fetchall()
            vote_map = {clean(r["event_uid"]): {"score": int(r["score"]), "votes": int(r["n"])} for r in rows}
            rep_rows = con.execute(
                f"""
                select event_uid, count(*) as n from moderation_reports
                where status = 'open' and event_uid in ({placeholders}) group by event_uid
                """,
                tuple(uids),
            ).fetchall()
            rsvp_rows = con.execute(
                f"""
                select event_uid, status, count(*) as n from rsvps
                where event_uid in ({placeholders}) group by event_uid, status
                """,
                tuple(uids),
            ).fetchall()
            con.close()
        except Exception:
            rep_rows = []
            rsvp_rows = []
    else:
        rep_rows = []
        rsvp_rows = []
    rep_map = {clean(r["event_uid"]): int(r["n"]) for r in rep_rows}
    rsvp_map: Dict[str, Dict[str, int]] = {}
    for r in rsvp_rows:
        rsvp_map.setdefault(clean(r["event_uid"]), {})[clean(r["status"])] = int(r["n"])
    for e in events:
        uid = clean(e.get("event_uid", ""))
        e["freshness"] = freshness_for(e)
        e["topics"] = extract_topics(e)
        v = vote_map.get(uid, {"score": 0, "votes": 0})
        open_reports = rep_map.get(uid, 0)
        e["correction"] = {
            "score": v["score"],
            "votes": v["votes"],
            "open_reports": open_reports,
            "flagged": open_reports >= 3 or v["score"] <= -3,
            "verified": v["score"] >= 3,
        }
        e["attendees"] = rsvp_map.get(uid, {})
    return events


def compute_source_health(rows: List[Dict]) -> List[Dict]:
    per_source: Dict[str, Dict] = {}
    for e in rows:
        src = clean(e.get("source", "")).lower()
        if not src:
            continue
        if src not in per_source:
            per_source[src] = {
                "source": src,
                "total": 0,
                "withPoster": 0,
                "exactTime": 0,
                "inferredDescription": 0,
                "lowQuality": 0,
                "latestDate": "",
                "dupes": {},
            }
        row = per_source[src]
        row["total"] += 1
        imgs = e.get("image_urls") or []
        if isinstance(imgs, list) and len(imgs) > 0:
            row["withPoster"] += 1
        st = clean(e.get("start_time", ""))
        if re.match(r"^\d{1,2}:\d{2}\s?(?:am|pm)?$", st, flags=re.I):
            row["exactTime"] += 1
        desc = clean(e.get("description", "")).lower()
        if any(k in desc for k in ("please confirm final details", "community members are welcome")):
            row["inferredDescription"] += 1
        if not st or "after " in st.lower() or len(imgs) == 0:
            row["lowQuality"] += 1
        if clean(e.get("date", "")) > row["latestDate"]:
            row["latestDate"] = clean(e.get("date", ""))
        dk = "|".join([clean(e.get("title", "")).lower(), clean(e.get("date", "")), clean(e.get("start_time", "")).lower()])
        row["dupes"][dk] = row["dupes"].get(dk, 0) + 1

    out: List[Dict] = []
    for src, row in sorted(per_source.items()):
        total = max(1, int(row["total"]))
        duplicate_rows = sum(v - 1 for v in row["dupes"].values() if v > 1)
        out.append(
            {
                "source": src,
                "total": row["total"],
                "posterPct": round(row["withPoster"] * 100 / total),
                "exactTimePct": round(row["exactTime"] * 100 / total),
                "inferredDescPct": round(row["inferredDescription"] * 100 / total),
                "lowQualityPct": round(row["lowQuality"] * 100 / total),
                "latestDate": row["latestDate"],
                "duplicateRows": duplicate_rows,
            }
        )
    return out


def build_chat_reply(message: str, rows: List[Dict]) -> str:
    q = clean(message).lower()
    if not q:
        return "Ask me about masjid events, dates, times, locations, or RSVP links."
    q_tokens = [t for t in re.findall(r"[a-z0-9]+", q) if len(t) > 2]

    def score(e: Dict) -> int:
        hay = " ".join(
            [
                clean(e.get("title", "")).lower(),
                clean(e.get("description", "")).lower(),
                clean(e.get("source", "")).lower(),
                clean(e.get("location_name", "")).lower(),
                clean(e.get("date", "")).lower(),
            ]
        )
        s = 0
        for tok in q_tokens:
            if tok in hay:
                s += 3
        if "today" in q and e.get("date") == date.today().isoformat():
            s += 2
        if "tomorrow" in q and e.get("date") == (date.today() + timedelta(days=1)).isoformat():
            s += 2
        return s

    ranked = sorted(rows, key=lambda e: (score(e), e.get("date", ""), e.get("start_time", "")), reverse=True)
    top = [e for e in ranked if score(e) > 0][:5]
    if not top:
        top = ranked[:5]
    if not top:
        return "I could not find matching events right now."

    lines = ["Here are the best matching events:"]
    for e in top:
        when = e.get("start_time") or "Time TBD"
        where = e.get("location_name") or e.get("source", "").upper()
        line = f"- {e.get('title','Untitled')} ({e.get('date','Date TBD')} at {when}) - {where}"
        if clean(e.get("rsvp_link", "")):
            line += f" | RSVP: {e.get('rsvp_link')}"
        lines.append(line)
    return "\n".join(lines)


@app.after_request
def add_cors_headers(resp):
    allowed_origins = [clean(x) for x in os.getenv("APP_CORS_ORIGINS", "").split(",") if clean(x)]
    single_origin = clean(os.getenv("APP_CORS_ORIGIN", ""))
    if single_origin:
        allowed_origins.append(single_origin)
    origin = clean(request.headers.get("Origin", ""))
    if origin and origin in allowed_origins:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    elif not allowed_origins:
        # explicit fallback for local development only
        if origin in {"", "http://localhost:19006", "http://127.0.0.1:19006"}:
            resp.headers["Access-Control-Allow-Origin"] = "http://localhost:19006"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
    return resp


@app.before_request
def refresh_cache_for_api_requests():
    if request.path.startswith("/api/"):
        refresh_events_cache_if_needed()


@app.get("/api/meta")
def api_meta():
    sources = sorted({e["source"] for e in EVENTS_CACHE if e.get("source")})
    dates = [parse_iso_date(e.get("date", "")) for e in EVENTS_CACHE]
    dates = [d for d in dates if d]
    min_date = min(dates) if dates else date.today()
    max_date = max(dates) if dates else date.today() + timedelta(days=120)
    return jsonify(
        {
            "sources": sources,
            "default_reference": sources[0] if sources else "",
            "min_date": min_date.isoformat(),
            "max_date": max_date.isoformat(),
            "today": date.today().isoformat(),
            "total_events": len(EVENTS_CACHE),
            # Monotonic version string tied to the pipeline output file's mtime
            # AND the server's enrichment schema version. Bumping the schema
            # string forces every client to refetch so new fields (freshness,
            # topics, correction, attendees) appear on previously cached events.
            "data_version": (str(int(EVENTS_CACHE_MTIME)) if EVENTS_CACHE_MTIME else "0") + "-v3",
        }
    )


@app.get("/api/events")
def api_events():
    start_str = request.args.get("start", date.today().isoformat())
    end_str = request.args.get("end", (date.today() + timedelta(days=45)).isoformat())
    query = request.args.get("q", "")
    ref = request.args.get("ref", "")
    radius = int(request.args.get("radius", "35"))
    lat_raw = clean(request.args.get("lat", ""))
    lon_raw = clean(request.args.get("lon", ""))
    sources_raw = request.args.get("sources", "")
    try:
        user_lat = float(lat_raw) if lat_raw else None
        user_lon = float(lon_raw) if lon_raw else None
    except ValueError:
        user_lat = None
        user_lon = None

    start_d = parse_iso_date(start_str) or date.today()
    end_d = parse_iso_date(end_str) or (start_d + timedelta(days=45))
    if end_d < start_d:
        end_d = start_d

    all_sources = sorted({e["source"] for e in EVENTS_CACHE if e.get("source")})
    requested_sources = [clean(s) for s in sources_raw.split(",") if clean(s)]
    sources = requested_sources if requested_sources else all_sources

    rows = filter_events(
        start_date=start_d,
        end_date=end_d,
        sources=sources,
        query=query,
        reference_source=ref,
        radius_miles=max(1, min(radius, 500)),
        user_lat=user_lat,
        user_lon=user_lon,
    )
    enrich_events(rows)
    return jsonify({"count": len(rows), "events": rows})


@app.get("/api/events/past")
def api_events_past():
    query = request.args.get("q", "")
    sources_raw = request.args.get("sources", "")
    limit = max(1, min(int(request.args.get("limit", "60")), 200))
    all_sources = sorted({e["source"] for e in EVENTS_CACHE if e.get("source")})
    requested_sources = [clean(s) for s in sources_raw.split(",") if clean(s)]
    sources = requested_sources if requested_sources else all_sources
    today = date.today()
    rows = filter_events(
        start_date=date(2000, 1, 1),
        end_date=today - timedelta(days=1),
        sources=sources,
        query=query,
        reference_source="",
        radius_miles=500,
    )
    rows.sort(key=lambda x: (x.get("date", ""), x.get("start_time", "") or "99:99", x.get("title", "")), reverse=True)
    limited = rows[:limit]
    enrich_events(limited)
    return jsonify({"count": len(limited), "events": limited})


@app.get("/api/events/<event_uid>/ics")
def api_event_ics(event_uid: str):
    uid = clean(event_uid)
    ev = next((e for e in EVENTS_CACHE if clean(e.get("event_uid", "")) == uid), None)
    if not ev:
        return jsonify({"error": "Event not found"}), 404
    dt_start = (clean(ev.get("date", "")) or date.today().isoformat()).replace("-", "")
    t_start = normalize_time(ev.get("start_time", ""))
    t_end = normalize_time(ev.get("end_time", ""))
    dtstart = f"{dt_start}T{(t_start or '1200').replace(':','')}00"
    dtend = f"{dt_start}T{(t_end or t_start or '1300').replace(':','')}00"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Masjidly//Events//EN",
        "BEGIN:VEVENT",
        f"UID:{uid}@masjidly",
        f"DTSTAMP:{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART:{dtstart}",
        f"DTEND:{dtend}",
        f"SUMMARY:{clean(ev.get('title',''))}",
        f"DESCRIPTION:{clean(ev.get('description',''))}",
        f"LOCATION:{clean(ev.get('location_name',''))} {clean(ev.get('address',''))}".strip(),
        f"URL:{clean(ev.get('source_url',''))}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    from flask import Response

    return Response(
        "\r\n".join(lines) + "\r\n",
        headers={
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": f'attachment; filename="masjidly-{uid}.ics"',
        },
    )


@app.get("/api/events/<event_uid>")
def api_event_detail(event_uid: str):
    uid = clean(event_uid)
    ev = next((e for e in EVENTS_CACHE if clean(e.get("event_uid", "")) == uid), None)
    if not ev:
        return jsonify({"error": "Event not found"}), 404
    enrich_events([ev])
    return jsonify({"event": ev})


@app.post("/api/auth/register")
def api_auth_register():
    payload = request.get_json(silent=True) or {}
    email = clean(str(payload.get("email", ""))).lower()
    password = str(payload.get("password", ""))
    if not email or "@" not in email or len(password) < 6:
        return jsonify({"error": "Valid email and password (>=6 chars) are required."}), 400
    con = db_conn()
    try:
        exists = con.execute("select id from users where email = ?", (email,)).fetchone()
        if exists:
            return jsonify({"error": "Email already registered."}), 409
        cur = con.execute(
            "insert into users (email, password_hash, oauth_provider, created_at) values (?, ?, '', ?)",
            (email, generate_password_hash(password), now_iso()),
        )
        user_id = int(cur.lastrowid)
        ensure_profile(user_id, con)
        token = secrets.token_urlsafe(36)
        expires_at = (datetime.utcnow() + timedelta(days=21)).isoformat()
        con.execute(
            "insert into sessions (token, user_id, expires_at, created_at) values (?, ?, ?, ?)",
            (token, user_id, expires_at, now_iso()),
        )
        con.commit()
        return jsonify({"token": token, "user": {"id": user_id, "email": email}})
    finally:
        con.close()


@app.post("/api/auth/login")
def api_auth_login():
    payload = request.get_json(silent=True) or {}
    email = clean(str(payload.get("email", ""))).lower()
    password = str(payload.get("password", ""))
    con = db_conn()
    try:
        row = con.execute("select id, email, password_hash, role from users where email = ?", (email,)).fetchone()
        if not row or not check_password_hash(row["password_hash"], password):
            return jsonify({"error": "Invalid credentials."}), 401
        token = secrets.token_urlsafe(36)
        expires_at = (datetime.utcnow() + timedelta(days=21)).isoformat()
        con.execute(
            "insert into sessions (token, user_id, expires_at, created_at) values (?, ?, ?, ?)",
            (token, int(row["id"]), expires_at, now_iso()),
        )
        con.commit()
        ensure_profile(int(row["id"]), con)
        return jsonify({"token": token, "user": {"id": int(row["id"]), "email": clean(row["email"]), "role": clean(row["role"] or "user")}})
    finally:
        con.close()


@app.post("/api/auth/logout")
def api_auth_logout():
    token = bearer_token()
    if not token:
        return jsonify({"ok": True})
    con = db_conn()
    try:
        con.execute("delete from sessions where token = ?", (token,))
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/auth/me")
def api_auth_me():
    user = auth_user()
    if not user:
        return jsonify({"authenticated": False})
    return jsonify(
        {
            "authenticated": True,
            "user": {"id": int(user["id"]), "email": clean(user["email"]), "role": clean(user["role"] or "user")},
        }
    )


@app.get("/api/profile")
def api_profile_get():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    ensure_profile(int(user["id"]))
    con = db_conn()
    try:
        p = con.execute("select * from profiles where user_id = ?", (int(user["id"]),)).fetchone()
        n = con.execute("select * from notification_settings where user_id = ?", (int(user["id"]),)).fetchone()
        profile = {
            "favorite_sources": json.loads(p["favorite_sources"] or "[]"),
            "audience_filter": clean(p["audience_filter"] or "all"),
            "radius": int(p["radius"] or 35),
            "onboarding_done": bool(int(p["onboarding_done"] or 0)),
            "home_lat": p["home_lat"],
            "home_lon": p["home_lon"],
            "expo_push_token": clean(p["expo_push_token"] or ""),
            "notifications": {
                "new_event_followed": bool(int(n["new_event_followed"] or 0)),
                "tonight_after_maghrib": bool(int(n["tonight_after_maghrib"] or 0)),
                "rsvp_reminders": bool(int(n["rsvp_reminders"] or 0)),
            },
        }
        return jsonify({"user": {"id": int(user["id"]), "email": clean(user["email"])}, "profile": profile})
    finally:
        con.close()


@app.put("/api/profile")
def api_profile_put():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    favorite_sources = payload.get("favorite_sources")
    audience_filter = clean(str(payload.get("audience_filter", "all"))) or "all"
    radius = int(payload.get("radius", 35) or 35)
    onboarding_done = 1 if bool(payload.get("onboarding_done", False)) else 0
    home_lat = payload.get("home_lat")
    home_lon = payload.get("home_lon")
    expo_push_token = clean(str(payload.get("expo_push_token", "")))
    notifications = payload.get("notifications", {}) if isinstance(payload.get("notifications"), dict) else {}
    fav_json = json.dumps([clean(str(s)).lower() for s in (favorite_sources or []) if clean(str(s))])
    con = db_conn()
    try:
        ensure_profile(int(user["id"]))
        con.execute(
            """
            update profiles
            set favorite_sources = ?, audience_filter = ?, radius = ?, onboarding_done = ?,
                home_lat = ?, home_lon = ?, expo_push_token = ?, updated_at = ?
            where user_id = ?
            """,
            (
                fav_json,
                audience_filter,
                max(1, min(radius, 500)),
                onboarding_done,
                home_lat,
                home_lon,
                expo_push_token,
                now_iso(),
                int(user["id"]),
            ),
        )
        con.execute(
            """
            update notification_settings
            set new_event_followed = ?, tonight_after_maghrib = ?, rsvp_reminders = ?, updated_at = ?
            where user_id = ?
            """,
            (
                1 if bool(notifications.get("new_event_followed", True)) else 0,
                1 if bool(notifications.get("tonight_after_maghrib", True)) else 0,
                1 if bool(notifications.get("rsvp_reminders", True)) else 0,
                now_iso(),
                int(user["id"]),
            ),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/notifications/preview")
def api_notifications_preview():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    ensure_profile(int(user["id"]))
    con = db_conn()
    try:
        p = con.execute("select * from profiles where user_id = ?", (int(user["id"]),)).fetchone()
        fav = json.loads(p["favorite_sources"] or "[]")
        radius = int(p["radius"] or 35)
    finally:
        con.close()
    today = date.today()
    upcoming = filter_events(
        start_date=today,
        end_date=today + timedelta(days=2),
        sources=fav,
        query="",
        reference_source="",
        radius_miles=radius,
    )[:6]
    previews = []
    for e in upcoming:
        previews.append(
            {
                "type": "new_event_followed",
                "text": f"New event at {clean(e.get('source','')).upper()}: {clean(e.get('title',''))} ({clean(e.get('date',''))}).",
                "event_uid": clean(e.get("event_uid", "")),
            }
        )
        if "maghrib" in clean(e.get("title", "")).lower() or "maghrib" in clean(e.get("description", "")).lower():
            previews.append(
                {
                    "type": "tonight_after_maghrib",
                    "text": f"Tonight after Maghrib: {clean(e.get('title',''))} at {clean(e.get('location_name',''))}.",
                    "event_uid": clean(e.get("event_uid", "")),
                }
            )
    return jsonify({"previews": previews[:8]})


@app.post("/api/moderation/report")
def api_moderation_report():
    payload = request.get_json(silent=True) or {}
    event_uid = clean(str(payload.get("event_uid", "")))
    issue_type = clean(str(payload.get("issue_type", ""))) or "general"
    details = clean(str(payload.get("details", "")))
    if not event_uid:
        return jsonify({"error": "event_uid is required"}), 400
    user = auth_user()
    reported_by = int(user["id"]) if user else None
    con = db_conn()
    try:
        con.execute(
            """
            insert into moderation_reports (event_uid, issue_type, details, status, reported_by, created_at, updated_at)
            values (?, ?, ?, 'open', ?, ?, ?)
            """,
            (event_uid, issue_type, details, reported_by, now_iso(), now_iso()),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/moderation/reports")
def api_moderation_reports():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    if not is_admin(user):
        return jsonify({"error": "Admin role required"}), 403
    con = db_conn()
    try:
        rows = con.execute(
            "select id, event_uid, issue_type, details, status, reported_by, created_at, updated_at from moderation_reports order by created_at desc limit 300"
        ).fetchall()
        return jsonify({"reports": [dict(r) for r in rows]})
    finally:
        con.close()


@app.put("/api/moderation/reports/<int:report_id>")
def api_moderation_reports_update(report_id: int):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    if not is_admin(user):
        return jsonify({"error": "Admin role required"}), 403
    payload = request.get_json(silent=True) or {}
    status = clean(str(payload.get("status", ""))).lower()
    if status not in {"open", "in_review", "resolved", "dismissed"}:
        return jsonify({"error": "invalid status"}), 400
    con = db_conn()
    try:
        con.execute(
            "update moderation_reports set status = ?, updated_at = ? where id = ?",
            (status, now_iso(), report_id),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/source-health")
def api_source_health():
    return jsonify({"stats": compute_source_health(EVENTS_CACHE)})


@app.post("/api/cache/reload")
def api_cache_reload():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    if not is_admin(user):
        return jsonify({"error": "Admin role required"}), 403
    refresh_events_cache_if_needed(force=True)
    return jsonify({"ok": True, "events": len(EVENTS_CACHE)})


@app.post("/api/chat")
def api_chat():
    payload = request.get_json(silent=True) or {}
    message = clean(str(payload.get("message", "")))
    filters = payload.get("filters", {}) if isinstance(payload.get("filters"), dict) else {}
    start_d = parse_iso_date(str(filters.get("start", ""))) or date.today()
    end_d = parse_iso_date(str(filters.get("end", ""))) or (start_d + timedelta(days=90))
    sources = filters.get("sources") if isinstance(filters.get("sources"), list) else []
    query = clean(str(filters.get("query", "")))
    ref = clean(str(filters.get("reference", "")))
    radius = int(filters.get("radius", 50) or 50)
    lat_raw = clean(str(filters.get("lat", "")))
    lon_raw = clean(str(filters.get("lon", "")))
    try:
        user_lat = float(lat_raw) if lat_raw else None
        user_lon = float(lon_raw) if lon_raw else None
    except ValueError:
        user_lat = None
        user_lon = None
    rows = filter_events(
        start_date=start_d,
        end_date=end_d,
        sources=[clean(s) for s in sources if clean(s)],
        query=query,
        reference_source=ref,
        radius_miles=max(1, min(radius, 500)),
        user_lat=user_lat,
        user_lon=user_lon,
    )
    answer = build_chat_reply(message, rows)
    return jsonify({"answer": answer, "matches": rows[:5]})


# =====================================================================
# Feature endpoints (roadmap items: 2, 13, 17, 18, 21, 23, 24, 31, 40, 46, 49)
# =====================================================================

DEFAULT_PRAYERS = ("fajr", "dhuhr", "asr", "maghrib", "isha")

HALAQA_TOPICS = [
    ("seerah", ["seerah", "prophet", "rasul", "madani era", "makki era"]),
    ("tafsir", ["tafsir", "quran class", "quran study", "tafseer"]),
    ("tajweed", ["tajweed", "recitation", "qira", "qirat"]),
    ("fiqh", ["fiqh", "jurisprudence", "halal", "haram", "hadith commentary"]),
    ("aqeedah", ["aqeedah", "aqidah", "creed", "tawheed"]),
    ("arabic", ["arabic class", "arabic language", "lughat"]),
    ("youth", ["youth", "teen", "msa", "highschooler", "middleschooler"]),
    ("sisters", ["sisters only", "women only", "sisters halaqa", "sisters circle"]),
    ("brothers", ["brothers only", "men only", "brothers halaqa"]),
    ("family", ["family", "potluck", "eid festival", "community dinner"]),
    ("kids", ["kids", "children", "sunday school", "weekend school", "quran kids"]),
    ("jumuah", ["jumuah", "jummah", "jumma", "friday prayer", "khutbah"]),
    ("fundraiser", ["fundraiser", "fundraising", "banquet", "gala"]),
    ("lecture", ["lecture", "talk", "halaqa", "circle", "study"]),
]


def extract_topics(event: Dict) -> List[str]:
    hay = " ".join(
        [
            clean(event.get("title", "")),
            clean(event.get("description", "")),
            clean(event.get("category", "")),
            clean(event.get("poster_ocr_text", "")),
        ]
    ).lower()
    out: List[str] = []
    for tag, kws in HALAQA_TOPICS:
        if any(k in hay for k in kws):
            out.append(tag)
    if event.get("speaker"):
        out.append("has-speaker")
    return out


def freshness_for(event: Dict) -> Dict:
    """Return {label, color, source_type, posted_at} to drive the 'freshness' pill (#41)."""
    st = clean(event.get("source_type", "") or "").lower() or "unknown"
    posted = clean(event.get("posted_at_utc", ""))
    days_old: Optional[int] = None
    if posted:
        try:
            dt = datetime.fromisoformat(posted.replace("Z", ""))
            days_old = max(0, (datetime.utcnow() - dt).days)
        except Exception:
            days_old = None
    color = "green"
    if st == "synthetic_jummah":
        color = "blue"
    elif days_old is None:
        color = "gray" if st == "website" else "yellow"
    elif days_old <= 3:
        color = "green"
    elif days_old <= 14:
        color = "yellow"
    else:
        color = "orange"
    pretty = {
        "instagram": "Instagram",
        "instagram_recurring": "Instagram (recurring)",
        "email": "Email",
        "website": "Website",
        "synthetic_jummah": "Weekly Jumu'ah",
    }.get(st, st.title() or "Source")
    suffix = ""
    if days_old is not None:
        if days_old == 0:
            suffix = " · today"
        elif days_old == 1:
            suffix = " · 1d ago"
        elif days_old < 30:
            suffix = f" · {days_old}d ago"
        else:
            suffix = f" · {days_old // 30}mo ago"
    return {"label": f"{pretty}{suffix}", "color": color, "source_type": st, "posted_at": posted, "days_old": days_old}


# ---- RSVP + attendee visibility (#18) ------------------------------------
@app.post("/api/events/<event_uid>/rsvp")
def api_event_rsvp(event_uid: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    status = clean(str(payload.get("status", ""))).lower()
    if status not in {"going", "interested", "none"}:
        return jsonify({"error": "status must be going|interested|none"}), 400
    con = db_conn()
    try:
        if status == "none":
            con.execute("delete from rsvps where user_id = ? and event_uid = ?", (int(user["id"]), event_uid))
        else:
            con.execute(
                """
                insert into rsvps (user_id, event_uid, status, created_at) values (?, ?, ?, ?)
                on conflict(user_id, event_uid) do update set status = excluded.status, created_at = excluded.created_at
                """,
                (int(user["id"]), event_uid, status, now_iso()),
            )
        con.commit()
        rows = con.execute(
            "select status, count(*) as n from rsvps where event_uid = ? group by status",
            (event_uid,),
        ).fetchall()
        counts = {r["status"]: int(r["n"]) for r in rows}
        return jsonify({"ok": True, "counts": counts})
    finally:
        con.close()


@app.get("/api/events/<event_uid>/attendees")
def api_event_attendees(event_uid: str):
    user = auth_user()
    con = db_conn()
    try:
        rows = con.execute(
            """
            select r.status, u.email, u.id as uid
            from rsvps r join users u on u.id = r.user_id
            where r.event_uid = ?
            order by r.created_at desc
            """,
            (event_uid,),
        ).fetchall()
        going = [{"name": r["email"].split("@")[0], "uid": int(r["uid"])} for r in rows if r["status"] == "going"]
        interested = [
            {"name": r["email"].split("@")[0], "uid": int(r["uid"])} for r in rows if r["status"] == "interested"
        ]
        friend_names: List[str] = []
        if user:
            follow_rows = con.execute(
                "select followee_id from follows where follower_id = ?", (int(user["id"]),)
            ).fetchall()
            friends = {int(r["followee_id"]) for r in follow_rows}
            for a in going:
                if a["uid"] in friends:
                    friend_names.append(a["name"])
        return jsonify(
            {
                "going": len(going),
                "interested": len(interested),
                "friend_going_names": friend_names[:3],
                "friend_going_total": len(friend_names),
                "sample_going": [a["name"] for a in going[:6]],
            }
        )
    finally:
        con.close()


@app.post("/api/users/<int:other_id>/follow")
def api_follow(other_id: int):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    con = db_conn()
    try:
        con.execute(
            "insert or ignore into follows (follower_id, followee_id, created_at) values (?, ?, ?)",
            (int(user["id"]), other_id, now_iso()),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


# ---- Post-event reflections (#21) ----------------------------------------
@app.post("/api/events/<event_uid>/reflection")
def api_event_reflection(event_uid: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    rating = int(payload.get("rating", 0) or 0)
    text = clean(str(payload.get("text", "")))[:1000]
    visibility = clean(str(payload.get("visibility", "public"))).lower()
    if visibility not in {"public", "friends", "private"}:
        visibility = "public"
    con = db_conn()
    try:
        con.execute(
            "insert into reflections (user_id, event_uid, rating, text, visibility, created_at) values (?, ?, ?, ?, ?, ?)",
            (int(user["id"]), event_uid, max(1, min(rating, 5)), text, visibility, now_iso()),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/events/<event_uid>/reflections")
def api_event_reflections(event_uid: str):
    con = db_conn()
    try:
        rows = con.execute(
            """
            select r.rating, r.text, r.visibility, r.created_at, u.email
            from reflections r join users u on u.id = r.user_id
            where r.event_uid = ? and r.visibility = 'public'
            order by r.created_at desc limit 50
            """,
            (event_uid,),
        ).fetchall()
        out = [
            {
                "name": r["email"].split("@")[0],
                "rating": int(r["rating"]),
                "text": clean(r["text"]),
                "created_at": clean(r["created_at"]),
            }
            for r in rows
        ]
        avg = (sum(r["rating"] for r in out) / len(out)) if out else None
        return jsonify({"reflections": out, "avg_rating": avg, "count": len(out)})
    finally:
        con.close()


@app.get("/api/reflections/prompts")
def api_reflections_prompts():
    """Events that ended yesterday for this user with no reflection yet (#21)."""
    user = auth_user()
    if not user:
        return jsonify({"prompts": []})
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    con = db_conn()
    try:
        rsvp_rows = con.execute(
            "select event_uid from rsvps where user_id = ? and status in ('going','interested')",
            (int(user["id"]),),
        ).fetchall()
        uids = {clean(r["event_uid"]) for r in rsvp_rows}
        already = con.execute(
            "select event_uid from reflections where user_id = ?", (int(user["id"]),)
        ).fetchall()
        done = {clean(r["event_uid"]) for r in already}
        pending: List[Dict] = []
        for e in EVENTS_CACHE:
            uid = clean(e.get("event_uid", ""))
            d = clean(e.get("date", ""))
            if uid in uids and uid not in done and d and d <= yesterday and d >= (date.today() - timedelta(days=14)).isoformat():
                pending.append(
                    {
                        "event_uid": uid,
                        "title": clean(e.get("title", "")),
                        "date": d,
                        "source": clean(e.get("source", "")),
                        "image_urls": e.get("image_urls") or [],
                    }
                )
        return jsonify({"prompts": pending[:5]})
    finally:
        con.close()


# ---- Iqama (#2) ----------------------------------------------------------
@app.get("/api/iqama/<source>")
def api_iqama_get(source: str):
    src = clean(source).lower()
    con = db_conn()
    try:
        rows = con.execute(
            "select prayer, iqama_time, jumuah_times, updated_at from iqama where source = ?",
            (src,),
        ).fetchall()
        data = {
            r["prayer"]: {
                "iqama": clean(r["iqama_time"]),
                "jumuah_times": json.loads(r["jumuah_times"] or "[]"),
                "updated_at": clean(r["updated_at"]),
            }
            for r in rows
        }
        for p in DEFAULT_PRAYERS:
            data.setdefault(p, {"iqama": "", "jumuah_times": [], "updated_at": ""})
        return jsonify({"source": src, "iqama": data})
    finally:
        con.close()


@app.post("/api/iqama/<source>")
def api_iqama_post(source: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    src = clean(source).lower()
    if not is_admin(user) and not _user_manages_source(int(user["id"]), src):
        return jsonify({"error": "Must be admin or verified masjid admin"}), 403
    payload = request.get_json(silent=True) or {}
    con = db_conn()
    try:
        for prayer, val in payload.items():
            p = clean(str(prayer)).lower()
            if p not in (*DEFAULT_PRAYERS, "jumuah"):
                continue
            iqama_time = clean(str(val.get("iqama", ""))) if isinstance(val, dict) else clean(str(val))
            jumuah = val.get("jumuah_times", []) if isinstance(val, dict) else []
            con.execute(
                """
                insert into iqama (source, prayer, iqama_time, jumuah_times, set_by, updated_at)
                values (?, ?, ?, ?, ?, ?)
                on conflict(source, prayer) do update set
                  iqama_time = excluded.iqama_time,
                  jumuah_times = excluded.jumuah_times,
                  set_by = excluded.set_by,
                  updated_at = excluded.updated_at
                """,
                (src, p, iqama_time, json.dumps(jumuah or []), int(user["id"]), now_iso()),
            )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


def seed_iqama_from_overrides() -> None:
    """One-time seed: import _iqama_overrides.json into the iqama table if it's empty (#2)."""
    path = Path("/Users/shaheersaud/Safar/events_by_masjid/_iqama_overrides.json")
    if not path.exists():
        return
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return
    con = db_conn()
    try:
        row = con.execute("select count(*) as n from iqama").fetchone()
        if row and int(row["n"] or 0) > 0:
            return
        for src, prayers in raw.items():
            if src.startswith("_") or not isinstance(prayers, dict):
                continue
            for prayer, payload in prayers.items():
                if not isinstance(payload, dict):
                    continue
                con.execute(
                    """
                    insert or ignore into iqama (source, prayer, iqama_time, jumuah_times, set_by, updated_at)
                    values (?, ?, ?, ?, null, ?)
                    """,
                    (
                        clean(src).lower(),
                        clean(prayer).lower(),
                        clean(str(payload.get("iqama", ""))),
                        json.dumps(payload.get("jumuah_times", []) or []),
                        now_iso(),
                    ),
                )
        con.commit()
    finally:
        con.close()


def _user_manages_source(user_id: int, source: str) -> bool:
    con = db_conn()
    try:
        row = con.execute(
            "select verified from admin_masjids where user_id = ? and source = ?",
            (user_id, source),
        ).fetchone()
        return bool(row and int(row["verified"]) == 1)
    finally:
        con.close()


# ---- Speakers / scholar directory (#24) ----------------------------------
SPEAKER_JUNK_WORDS = {
    "gallery",
    "contact",
    "education",
    "services",
    "appointment",
    "nikkah",
    "home",
    "about",
    "donate",
    "menu",
    "team",
    "privacy",
    "policy",
    "terms",
    "login",
    "register",
    "subscribe",
}


def _speaker_is_clean(name: str) -> bool:
    tokens = [t.lower() for t in re.findall(r"[A-Za-z]+", name)]
    if not tokens or len(tokens) > 5:
        return False
    if sum(1 for t in tokens if t in SPEAKER_JUNK_WORDS) > 0:
        return False
    letters = sum(len(t) for t in tokens)
    if letters < 4:
        return False
    return True


@app.get("/api/speakers")
def api_speakers():
    buckets: Dict[str, Dict] = {}
    today = date.today().isoformat()
    for e in EVENTS_CACHE:
        sp = clean(e.get("speaker", ""))
        if not sp or sp.lower() in {"n/a", "tba", "tbd"}:
            continue
        if not _speaker_is_clean(sp):
            continue
        key = re.sub(r"[^a-z0-9]+", "-", sp.lower()).strip("-")
        if not key:
            continue
        slot = buckets.setdefault(
            key,
            {
                "slug": key,
                "name": sp,
                "total_events": 0,
                "upcoming_events": 0,
                "sources": set(),
                "next_date": None,
                "next_title": "",
                "image_url": "",
            },
        )
        slot["total_events"] += 1
        slot["sources"].add(clean(e.get("source", "")))
        d = clean(e.get("date", ""))
        if d and d >= today:
            slot["upcoming_events"] += 1
            if not slot["next_date"] or d < slot["next_date"]:
                slot["next_date"] = d
                slot["next_title"] = clean(e.get("title", ""))
        if not slot["image_url"]:
            imgs = e.get("image_urls") or []
            if isinstance(imgs, list) and imgs:
                slot["image_url"] = clean(str(imgs[0]))
    out = []
    for v in buckets.values():
        out.append({**v, "sources": sorted(v["sources"])})
    out.sort(key=lambda x: (-x["upcoming_events"], -x["total_events"], x["name"].lower()))
    return jsonify({"speakers": out[:200], "count": len(out)})


@app.get("/api/speakers/<slug>")
def api_speaker_detail(slug: str):
    key = clean(slug).lower()
    matches = []
    for e in EVENTS_CACHE:
        sp = clean(e.get("speaker", ""))
        k = re.sub(r"[^a-z0-9]+", "-", sp.lower()).strip("-") if sp else ""
        if k == key:
            matches.append(e)
    if not matches:
        return jsonify({"error": "Unknown speaker"}), 404
    matches.sort(key=lambda x: (x.get("date", "") or "", x.get("start_time", "") or ""))
    upcoming = [m for m in matches if clean(m.get("date", "")) >= date.today().isoformat()]
    past = [m for m in matches if clean(m.get("date", "")) < date.today().isoformat()][-50:]
    return jsonify(
        {
            "slug": key,
            "name": clean(matches[0].get("speaker", "")),
            "upcoming": upcoming,
            "past": past,
            "total_events": len(matches),
        }
    )


# ---- Event series detection (#13) ----------------------------------------
_SERIES_CACHE: Dict = {"version": "", "series": []}


def _compute_series() -> List[Dict]:
    groups: Dict[Tuple[str, str], List[Dict]] = {}
    for e in EVENTS_CACHE:
        src = clean(e.get("source", "")).lower()
        title = normalize_title(e.get("title", ""))
        title = re.sub(r"\b(session|week|class|part|lesson|vol(ume)?)\s*\d+\b", "", title)
        title = re.sub(r"\b\d+\b", "", title).strip()
        if not src or not title or len(title) < 5:
            continue
        groups.setdefault((src, title), []).append(e)
    series: List[Dict] = []
    today = date.today().isoformat()
    for (src, title), items in groups.items():
        if len(items) < 3:
            continue
        items.sort(key=lambda x: clean(x.get("date", "")))
        upcoming = [x for x in items if clean(x.get("date", "")) >= today]
        if len(upcoming) < 2:
            continue
        series.append(
            {
                "series_id": hashlib.sha1(f"{src}|{title}".encode()).hexdigest()[:10],
                "source": src,
                "title": clean(items[0].get("title", "")),
                "count": len(items),
                "upcoming_count": len(upcoming),
                "image_url": (items[0].get("image_urls") or [""])[0] if items[0].get("image_urls") else "",
                "next_date": clean(upcoming[0].get("date", "")),
                "event_uids": [clean(x.get("event_uid", "")) for x in upcoming[:20]],
            }
        )
    series.sort(key=lambda s: (-s["upcoming_count"], s["next_date"]))
    return series


@app.get("/api/series")
def api_series():
    version = str(int(EVENTS_CACHE_MTIME)) if EVENTS_CACHE_MTIME else "0"
    if _SERIES_CACHE["version"] != version:
        _SERIES_CACHE["series"] = _compute_series()
        _SERIES_CACHE["version"] = version
    return jsonify({"series": _SERIES_CACHE["series"], "count": len(_SERIES_CACHE["series"])})


# ---- Community corrections voting (#40) ----------------------------------
@app.post("/api/events/<event_uid>/correction-vote")
def api_correction_vote(event_uid: str):
    user = auth_user()
    payload = request.get_json(silent=True) or {}
    weight = 1 if int(payload.get("weight", 1) or 1) > 0 else -1
    reason = clean(str(payload.get("reason", "")))[:200]
    con = db_conn()
    try:
        con.execute(
            "insert into correction_votes (event_uid, user_id, weight, reason, created_at) values (?, ?, ?, ?, ?)",
            (event_uid, int(user["id"]) if user else None, weight, reason, now_iso()),
        )
        con.commit()
        return jsonify({"ok": True})
    finally:
        con.close()


@app.get("/api/events/<event_uid>/correction-status")
def api_correction_status(event_uid: str):
    con = db_conn()
    try:
        row = con.execute(
            "select coalesce(sum(weight),0) as score, count(*) as n from correction_votes where event_uid = ?",
            (event_uid,),
        ).fetchone()
        reports = con.execute(
            "select count(*) as n from moderation_reports where event_uid = ? and status = 'open'",
            (event_uid,),
        ).fetchone()
        score = int(row["score"] or 0)
        votes = int(row["n"] or 0)
        open_reports = int(reports["n"] or 0)
        flagged = open_reports >= 3 or score <= -3
        verified = score >= 3
        return jsonify(
            {
                "flagged": flagged,
                "verified": verified,
                "score": score,
                "votes": votes,
                "open_reports": open_reports,
            }
        )
    finally:
        con.close()


# ---- Passport stamps (#31) ----------------------------------------------
@app.post("/api/passport/stamp")
def api_passport_stamp():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    source = clean(str(payload.get("source", ""))).lower()
    if not source:
        return jsonify({"error": "source required"}), 400
    if source not in {e.get("source") for e in EVENTS_CACHE}:
        return jsonify({"error": "unknown source"}), 400
    con = db_conn()
    try:
        con.execute(
            "insert or ignore into passport_stamps (user_id, source, created_at) values (?, ?, ?)",
            (int(user["id"]), source, now_iso()),
        )
        con.commit()
        rows = con.execute(
            "select source, created_at from passport_stamps where user_id = ? order by created_at",
            (int(user["id"]),),
        ).fetchall()
        return jsonify(
            {
                "ok": True,
                "stamps": [{"source": r["source"], "stamped_at": r["created_at"]} for r in rows],
                "total": len(rows),
                "goal": 24,
            }
        )
    finally:
        con.close()


@app.get("/api/passport/me")
def api_passport_me():
    user = auth_user()
    if not user:
        return jsonify({"stamps": [], "total": 0, "goal": 24})
    con = db_conn()
    try:
        rows = con.execute(
            "select source, created_at from passport_stamps where user_id = ? order by created_at",
            (int(user["id"]),),
        ).fetchall()
        return jsonify(
            {
                "stamps": [{"source": r["source"], "stamped_at": r["created_at"]} for r in rows],
                "total": len(rows),
                "goal": 24,
            }
        )
    finally:
        con.close()


# ---- Bulk ICS export (#17) ----------------------------------------------
@app.get("/api/events/bulk.ics")
def api_events_bulk_ics():
    sources_raw = request.args.get("sources", "")
    until_raw = request.args.get("until", "")
    start_raw = request.args.get("start", "")
    start_d = parse_iso_date(start_raw) or date.today()
    end_d = parse_iso_date(until_raw) or (start_d + timedelta(days=30))
    sources = [clean(s).lower() for s in sources_raw.split(",") if clean(s)]
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Masjidly//Bulk//EN", "X-WR-CALNAME:Masjidly Events"]
    count = 0
    for e in EVENTS_CACHE:
        d = parse_iso_date(e.get("date", ""))
        src = clean(e.get("source", "")).lower()
        if not d or d < start_d or d > end_d:
            continue
        if sources and src not in sources:
            continue
        uid = clean(e.get("event_uid", ""))
        dt_day = d.strftime("%Y%m%d")
        t_start = normalize_time(e.get("start_time", "")) or "12:00"
        t_end = normalize_time(e.get("end_time", "")) or t_start
        dtstart = f"{dt_day}T{t_start.replace(':','')}00"
        dtend = f"{dt_day}T{t_end.replace(':','')}00"
        lines += [
            "BEGIN:VEVENT",
            f"UID:{uid}@masjidly",
            f"DTSTAMP:{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}",
            f"DTSTART:{dtstart}",
            f"DTEND:{dtend}",
            f"SUMMARY:{clean(e.get('title',''))}",
            f"LOCATION:{clean(e.get('location_name',''))} {clean(e.get('address',''))}".strip(),
            f"URL:{clean(e.get('source_url',''))}",
            "END:VEVENT",
        ]
        count += 1
    lines.append("END:VCALENDAR")
    from flask import Response

    return Response(
        "\r\n".join(lines) + "\r\n",
        headers={
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="masjidly-bulk.ics"',
            "X-Events-Count": str(count),
        },
    )


# ---- Admin: claim masjid + event overrides (#46) -------------------------
@app.post("/api/admin/claim-masjid")
def api_admin_claim():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    source = clean(str(payload.get("source", ""))).lower()
    if not source:
        return jsonify({"error": "source required"}), 400
    token = secrets.token_urlsafe(24)
    con = db_conn()
    try:
        con.execute(
            "insert or ignore into admin_masjids (user_id, source, verified, verification_token, created_at) values (?, ?, ?, ?, ?)",
            (int(user["id"]), source, 1 if is_admin(user) else 0, token, now_iso()),
        )
        con.commit()
        return jsonify({"ok": True, "verified": is_admin(user), "verification_token": token})
    finally:
        con.close()


@app.get("/api/admin/my-masjids")
def api_admin_my_masjids():
    user = auth_user()
    if not user:
        return jsonify({"masjids": []})
    con = db_conn()
    try:
        rows = con.execute(
            "select source, verified, created_at from admin_masjids where user_id = ?", (int(user["id"]),)
        ).fetchall()
        return jsonify(
            {
                "masjids": [
                    {"source": r["source"], "verified": bool(int(r["verified"])), "created_at": r["created_at"]}
                    for r in rows
                ]
            }
        )
    finally:
        con.close()


@app.get("/api/admin/events")
def api_admin_events():
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    con = db_conn()
    try:
        if is_admin(user):
            sources = None
        else:
            rows = con.execute(
                "select source from admin_masjids where user_id = ? and verified = 1", (int(user["id"]),)
            ).fetchall()
            sources = {r["source"] for r in rows}
            if not sources:
                return jsonify({"events": []})
        out = []
        today = date.today().isoformat()
        for e in EVENTS_CACHE:
            if sources is not None and clean(e.get("source", "")).lower() not in sources:
                continue
            if clean(e.get("date", "")) < today:
                continue
            out.append(e)
        out.sort(key=lambda x: (x.get("date", ""), x.get("start_time", "")))
        return jsonify({"events": out[:500]})
    finally:
        con.close()


@app.put("/api/admin/events/<event_uid>")
def api_admin_events_update(event_uid: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    ev = next((e for e in EVENTS_CACHE if clean(e.get("event_uid", "")) == event_uid), None)
    if not ev:
        return jsonify({"error": "Event not found"}), 404
    src = clean(ev.get("source", "")).lower()
    if not is_admin(user) and not _user_manages_source(int(user["id"]), src):
        return jsonify({"error": "Not authorized for this masjid"}), 403
    payload = request.get_json(silent=True) or {}
    allowed = {
        "title",
        "description",
        "start_time",
        "end_time",
        "date",
        "location_name",
        "address",
        "speaker",
        "rsvp_link",
        "audience",
        "category",
    }
    clean_fields = {k: clean(str(v)) for k, v in payload.items() if k in allowed}
    con = db_conn()
    try:
        con.execute(
            """
            insert into event_overrides (event_uid, fields_json, edited_by, updated_at) values (?, ?, ?, ?)
            on conflict(event_uid) do update set fields_json = excluded.fields_json,
              edited_by = excluded.edited_by, updated_at = excluded.updated_at
            """,
            (event_uid, json.dumps(clean_fields), int(user["id"]), now_iso()),
        )
        con.commit()
    finally:
        con.close()
    ev.update(clean_fields)
    return jsonify({"ok": True, "event": ev})


# ---- Admin analytics (#49) ----------------------------------------------
@app.get("/api/admin/masjid/<source>/analytics")
def api_admin_analytics(source: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    src = clean(source).lower()
    if not is_admin(user) and not _user_manages_source(int(user["id"]), src):
        return jsonify({"error": "Not authorized"}), 403
    con = db_conn()
    try:
        upcoming = [e for e in EVENTS_CACHE if clean(e.get("source", "")).lower() == src and clean(e.get("date", "")) >= date.today().isoformat()]
        past_window = (date.today() - timedelta(days=30)).isoformat()
        past = [e for e in EVENTS_CACHE if clean(e.get("source", "")).lower() == src and past_window <= clean(e.get("date", "")) < date.today().isoformat()]
        src_uids = {clean(e.get("event_uid", "")) for e in upcoming + past}
        if not src_uids:
            return jsonify({"source": src, "upcoming": 0, "rsvps": 0, "reflections": 0, "views": 0, "top_speakers": []})
        placeholders = ",".join("?" for _ in src_uids)
        rsvp_row = con.execute(
            f"select count(*) as n from rsvps where event_uid in ({placeholders})",
            tuple(src_uids),
        ).fetchone()
        ref_row = con.execute(
            f"select count(*) as n, coalesce(avg(rating),0) as r from reflections where event_uid in ({placeholders})",
            tuple(src_uids),
        ).fetchone()
        views_row = con.execute(
            f"select count(*) as n from event_views where event_uid in ({placeholders})",
            tuple(src_uids),
        ).fetchone()
        stamp_row = con.execute(
            "select count(*) as n from passport_stamps where source = ?", (src,)
        ).fetchone()
        speaker_buckets: Dict[str, int] = {}
        for e in upcoming + past:
            sp = clean(e.get("speaker", ""))
            if sp:
                speaker_buckets[sp] = speaker_buckets.get(sp, 0) + 1
        top_speakers = sorted(speaker_buckets.items(), key=lambda x: -x[1])[:5]
        return jsonify(
            {
                "source": src,
                "upcoming": len(upcoming),
                "past_30d": len(past),
                "rsvps": int(rsvp_row["n"] or 0),
                "reflections": int(ref_row["n"] or 0),
                "avg_rating": float(ref_row["r"] or 0),
                "views": int(views_row["n"] or 0),
                "check_ins": int(stamp_row["n"] or 0),
                "top_speakers": [{"name": n, "count": c} for n, c in top_speakers],
            }
        )
    finally:
        con.close()


# ---- Event meta enrichment (freshness + topics) called by clients --------
@app.get("/api/events/<event_uid>/meta")
def api_event_meta(event_uid: str):
    ev = next((e for e in EVENTS_CACHE if clean(e.get("event_uid", "")) == event_uid), None)
    if not ev:
        return jsonify({"error": "Event not found"}), 404
    # fire-and-forget view counter
    try:
        con = db_conn()
        con.execute(
            "insert into event_views (event_uid, user_id, created_at) values (?, ?, ?)",
            (event_uid, auth_user()["id"] if auth_user() else None, now_iso()),
        )
        con.commit()
        con.close()
    except Exception:
        pass
    return jsonify(
        {
            "freshness": freshness_for(ev),
            "topics": extract_topics(ev),
        }
    )


# ---- IG import trigger (#48) --------------------------------------------
@app.post("/api/admin/scrape-ig/<source>")
def api_admin_scrape_ig(source: str):
    user = auth_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    src = clean(source).lower()
    if not is_admin(user) and not _user_manages_source(int(user["id"]), src):
        return jsonify({"error": "Not authorized"}), 403
    # This is a hand-off: we log the request; the pipeline picks it up next run.
    queue_path = Path("/Users/shaheersaud/Safar/events_by_masjid/_admin_scrape_queue.json")
    queue: List[Dict] = []
    if queue_path.exists():
        try:
            queue = json.loads(queue_path.read_text()) or []
        except Exception:
            queue = []
    queue.append({"source": src, "requested_by": int(user["id"]), "requested_at": now_iso()})
    queue_path.write_text(json.dumps(queue, indent=2))
    return jsonify({"ok": True, "queued": True, "queue_length": len(queue)})


ADMIN_DIR = Path("/Users/shaheersaud/Safar/safar-admin")


@app.get("/admin")
@app.get("/admin/")
def admin_index():
    target = ADMIN_DIR / "index.html"
    if not target.exists():
        return ("Admin dashboard not built", 404)
    return send_from_directory(str(ADMIN_DIR), "index.html")


@app.get("/admin/<path:asset>")
def admin_asset(asset: str):
    if not (ADMIN_DIR / asset).exists():
        return ("", 404)
    return send_from_directory(str(ADMIN_DIR), asset)


@app.get("/")
def index():
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Masjidly - Local Masjid Events</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --ink: #11203a;
      --muted: #5f6f89;
      --brand: #0f6fff;
      --brand-dark: #0a4fba;
      --ring: #dbe8ff;
      --chip: #eaf2ff;
      --card: #ffffff;
      --border: #e7edf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: linear-gradient(180deg, #f7faff 0%, #f4f7fb 100%);
      color: var(--ink);
    }
    .wrap { max-width: 1160px; margin: 0 auto; padding: 22px; }
    .hero {
      background: radial-gradient(1200px 300px at 0% 0%, #ddebff 0%, #ffffff 55%);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 22px;
      margin-bottom: 16px;
    }
    .title { font-size: 32px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    .subtitle { margin-top: 8px; color: var(--muted); font-size: 15px; }
    .toolbar {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
      box-shadow: 0 2px 10px rgba(16, 43, 95, 0.04);
    }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field label { font-size: 12px; color: var(--muted); font-weight: 600; }
    .field input, .field select {
      height: 40px; border: 1px solid var(--border); border-radius: 10px; padding: 0 10px;
      background: #fff; color: var(--ink); outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--ring); }
    .sources {
      grid-column: 1 / -1;
      display: flex; flex-wrap: wrap; gap: 8px;
      padding-top: 4px;
    }
    .source-chip {
      border: 1px solid var(--border);
      background: #fff;
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }
    .source-chip.active {
      background: var(--chip);
      border-color: #bfd4ff;
      color: #0d3f8c;
      font-weight: 700;
    }
    .actions { display: flex; gap: 10px; align-items: end; }
    .btn {
      height: 40px; border: 0; border-radius: 10px; padding: 0 14px; font-weight: 700; cursor: pointer;
      background: var(--brand); color: white;
    }
    .btn:hover { background: var(--brand-dark); }
    .stats { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
    .pill {
      background: #fff; border: 1px solid var(--border); border-radius: 999px; padding: 8px 12px;
      color: var(--muted); font-size: 13px;
    }
    .day {
      margin-top: 16px;
      margin-bottom: 8px;
      font-size: 18px;
      font-weight: 800;
      color: #183260;
    }
    .grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 2px 10px rgba(8, 31, 73, 0.05);
      display: flex; flex-direction: column;
    }
    .poster { width: 100%; height: 170px; object-fit: cover; background: #eef3fb; }
    .poster-fallback {
      height: 170px; display: grid; place-items: center; color: #8aa0c7; background: #f0f5ff; font-size: 42px;
    }
    .content { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .event-title { margin: 0; font-size: 17px; line-height: 1.25; }
    .meta { color: var(--muted); font-size: 13px; }
    .desc { color: #2a4066; font-size: 14px; line-height: 1.45; margin: 0; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      font-size: 11px; background: #f3f7ff; color: #3e5f95; border: 1px solid #dce8ff;
      border-radius: 999px; padding: 3px 8px;
    }
    .links { display: flex; gap: 10px; flex-wrap: wrap; }
    .links a { color: #0f61d8; text-decoration: none; font-weight: 600; font-size: 13px; }
    .links a:hover { text-decoration: underline; }
    .empty {
      border: 1px dashed #c8d7f3; border-radius: 14px; padding: 24px; text-align: center; color: var(--muted);
      background: #f8fbff;
    }
    @media (max-width: 1024px) {
      .toolbar { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1 class="title">Masjidly Local Events</h1>
      <div class="subtitle">Find nearby masjid events by date, distance, and interest — clear for families and community members.</div>
    </div>

    <div class="toolbar">
      <div class="field">
        <label>From</label>
        <input id="startDate" type="date" />
      </div>
      <div class="field">
        <label>To</label>
        <input id="endDate" type="date" />
      </div>
      <div class="field">
        <label>Reference Masjid</label>
        <select id="reference"></select>
      </div>
      <div class="field">
        <label>Radius (miles)</label>
        <input id="radius" type="number" min="5" max="100" step="5" value="35" />
      </div>
      <div class="field" style="grid-column: span 2;">
        <label>Search</label>
        <input id="query" type="text" placeholder="Search title, details, speaker..." />
      </div>
      <div class="sources" id="sources"></div>
      <div class="actions">
        <button class="btn" id="applyBtn">Apply Filters</button>
      </div>
    </div>

    <div class="stats" id="stats"></div>
    <div id="results"></div>
  </div>

  <script>
    const state = {
      sources: [],
      selectedSources: new Set(),
    };

    const byId = (id) => document.getElementById(id);

    function esc(str) {
      return (str || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function formatDay(iso) {
      const d = new Date(iso + "T00:00:00");
      return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }

    function renderSources() {
      const wrap = byId("sources");
      wrap.innerHTML = "";
      state.sources.forEach((src) => {
        const chip = document.createElement("button");
        chip.className = "source-chip active";
        chip.textContent = src.toUpperCase();
        chip.onclick = () => {
          if (state.selectedSources.has(src)) {
            state.selectedSources.delete(src);
            chip.classList.remove("active");
          } else {
            state.selectedSources.add(src);
            chip.classList.add("active");
          }
        };
        wrap.appendChild(chip);
      });
    }

    function buildCard(e) {
      const poster = (e.image_urls && e.image_urls.length) ? `<img class="poster" src="${esc(e.image_urls[0])}" alt="poster" />` : `<div class="poster-fallback">🕌</div>`;
      const chips = [e.category, e.audience].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
      const links = [
        e.rsvp_link ? `<a href="${esc(e.rsvp_link)}" target="_blank" rel="noreferrer">RSVP</a>` : "",
        e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noreferrer">Event Page</a>` : "",
      ].filter(Boolean).join("");
      const speaker = e.speaker ? `<div class="meta"><strong>Speaker:</strong> ${esc(e.speaker)}</div>` : "";
      const where = [e.location_name, e.address].filter(Boolean).join(" - ");
      const timeText = e.start_time && e.end_time ? `${e.start_time} - ${e.end_time}` : (e.start_time || "Time TBD");
      return `
        <article class="card">
          ${poster}
          <div class="content">
            <h3 class="event-title">${esc(e.title)}</h3>
            <div class="meta">${esc((e.source || "").toUpperCase())} • ${esc(timeText)}</div>
            ${speaker}
            ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ""}
            ${chips ? `<div class="chips">${chips}</div>` : ""}
            ${where ? `<div class="meta">${esc(where)}</div>` : ""}
            ${links ? `<div class="links">${links}</div>` : ""}
          </div>
        </article>
      `;
    }

    function renderResults(events) {
      const stats = byId("stats");
      const uniqueMasjids = new Set(events.map((e) => e.source)).size;
      stats.innerHTML = `
        <div class="pill">Events: <strong>${events.length}</strong></div>
        <div class="pill">Masjids: <strong>${uniqueMasjids}</strong></div>
      `;

      const results = byId("results");
      if (!events.length) {
        results.innerHTML = `<div class="empty">No events match your filters. Try increasing radius or date range.</div>`;
        return;
      }

      const grouped = new Map();
      for (const e of events) {
        if (!grouped.has(e.date)) grouped.set(e.date, []);
        grouped.get(e.date).push(e);
      }

      let html = "";
      for (const [day, rows] of grouped.entries()) {
        html += `<div class="day">${esc(formatDay(day))}</div>`;
        html += `<div class="grid">${rows.map(buildCard).join("")}</div>`;
      }
      results.innerHTML = html;
    }

    async function loadMeta() {
      const res = await fetch("/api/meta");
      const meta = await res.json();
      state.sources = meta.sources || [];
      state.selectedSources = new Set(state.sources);

      const ref = byId("reference");
      ref.innerHTML = state.sources.map((s) => `<option value="${esc(s)}">${esc(s.toUpperCase())}</option>`).join("");
      ref.value = meta.default_reference || state.sources[0] || "";

      byId("startDate").min = meta.min_date;
      byId("startDate").max = meta.max_date;
      byId("endDate").min = meta.min_date;
      byId("endDate").max = meta.max_date;

      byId("startDate").value = meta.today || meta.min_date;
      const endDefault = new Date((meta.today || meta.min_date) + "T00:00:00");
      endDefault.setDate(endDefault.getDate() + 45);
      const endIso = endDefault.toISOString().slice(0, 10);
      byId("endDate").value = endIso > meta.max_date ? meta.max_date : endIso;

      renderSources();
      await loadEvents();
    }

    async function loadEvents() {
      const params = new URLSearchParams();
      params.set("start", byId("startDate").value);
      params.set("end", byId("endDate").value);
      params.set("ref", byId("reference").value);
      params.set("radius", byId("radius").value || "35");
      params.set("q", byId("query").value || "");
      params.set("sources", Array.from(state.selectedSources).join(","));

      const res = await fetch("/api/events?" + params.toString());
      const data = await res.json();
      renderResults(data.events || []);
    }

    byId("applyBtn").addEventListener("click", () => loadEvents());
    byId("query").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadEvents();
    });

    loadMeta();
  </script>
</body>
</html>"""




try:
    seed_iqama_from_overrides()
except Exception:
    pass
try:
    apply_event_overrides(EVENTS_CACHE)
except Exception:
    pass


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=False)
