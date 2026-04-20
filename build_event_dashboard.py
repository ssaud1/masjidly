#!/usr/bin/env python3
from __future__ import annotations

import html
import json
import re
from datetime import date
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path("/Users/shaheersaud/Safar")
EVENTS_DIR = ROOT / "events_by_masjid"
REPORT_DIR = EVENTS_DIR / "_reports"
REPORT_HTML = REPORT_DIR / "masjid_events_dashboard.html"
REPORT_JSON = REPORT_DIR / "masjid_events_dashboard.json"

def discover_dashboard_sources() -> List[str]:
    out: List[str] = []
    for p in sorted(EVENTS_DIR.glob("*_events.json")):
        if not p.is_file() or p.name.startswith("_"):
            continue
        stem = p.stem
        if stem.endswith("_events"):
            out.append(stem[: -len("_events")])
    return sorted(set(out))


SOURCE_HOME = {
    "mcgp": "https://www.themuslimcenter.org/",
    "mcmc": "https://www.mcmcnj.org/",
    "darul_islah": "https://www.darulislah.org/events/",
    "alfalah": "https://alfalahcenter.org/events/",
    "icuc": "https://www.icucnj.com/",
    "ismc": "https://ismcnj.org/event-calendar/",
    "mcnj": "https://mcnjonline.com/",
    "iceb": "https://iceb.nj/",
    "iscj": "https://iscj.org/",
    "icpc": "https://www.icpcnj.org/",
    "nbic": "https://nbic.org/",
    "icsj": "https://www.icsjmasjid.org/",
    "masjid_al_wali": "https://www.masjidalwali.org/",
    "masjid_muhammad_newark": "https://www.masjidmuhammadnewark.org/",
    "icna_nj": "https://www.icnanj.org/",
    "jmic": "https://www.jmic.org/",
    "icmc": "https://icmcnj.com/",
    "icoc": "https://icoconline.org/",
    "bayonne_mc": "https://bayonnemasjid.com/",
    "hudson_ic": "https://www.instagram.com/hudsonislamic/",
    "clifton_ic": "https://www.instagram.com/islamiccenterofclifton/",
    "isbc": "https://www.isbcnj.org/",
    "mcjc": "https://muslimcenterjc.org/",
    "waarith": "https://www.instagram.com/masjidwaarithuddeen/",
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def title_key(title: str) -> str:
    t = clean(title).lower()
    t = re.sub(r"^[^\w]+", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return clean(t)


def load_json(path: Path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def event_key(e: Dict) -> Tuple[str, str]:
    return (clean(str(e.get("date", ""))), title_key(str(e.get("title", ""))))


def source_type_of(e: Dict) -> str:
    st = clean(str(e.get("source_type", ""))).lower()
    if st == "website":
        return "scraper"
    if st:
        return st
    src_url = clean(str(e.get("source_url", ""))).lower()
    if src_url.startswith("http"):
        return "scraper"
    if src_url.startswith("email://"):
        return "email"
    return "other"


def summarize(rows: List[Dict]) -> Dict:
    by_type = {"email": 0, "scraper": 0, "other": 0}
    for e in rows:
        st = source_type_of(e)
        if st in by_type:
            by_type[st] += 1
        else:
            by_type["other"] += 1
    email_keys = {event_key(e) for e in rows if source_type_of(e) == "email"}
    scraper_keys = {event_key(e) for e in rows if source_type_of(e) == "scraper"}
    return {
        "total": len(rows),
        "email": by_type["email"],
        "scraper": by_type["scraper"],
        "both_overlap": len(email_keys & scraper_keys),
        "email_only": len(email_keys - scraper_keys),
        "scraper_only": len(scraper_keys - email_keys),
    }


def merged_cards(rows: List[Dict]) -> List[Dict]:
    grouped: Dict[Tuple[str, str], List[Dict]] = {}
    for e in rows:
        k = event_key(e)
        if not k[0] or not k[1]:
            continue
        grouped.setdefault(k, []).append(e)
    cards: List[Dict] = []
    for (_, _), grp in grouped.items():
        grp = sorted(grp, key=lambda x: (0 if source_type_of(x) == "email" else 1))
        best = dict(grp[0])
        src = clean(str(best.get("source", ""))).lower()
        original_link = ""
        # Prefer exact HTTP source page from any contributing row.
        for row in grp:
            su = clean(str(row.get("source_url", "")))
            if su.startswith("http"):
                original_link = su
                break
        if not original_link:
            original_link = SOURCE_HOME.get(src, "")
        for e in grp[1:]:
            if not clean(str(best.get("start_time", ""))) and clean(str(e.get("start_time", ""))):
                best["start_time"] = e.get("start_time", "")
            if not clean(str(best.get("end_time", ""))) and clean(str(e.get("end_time", ""))):
                best["end_time"] = e.get("end_time", "")
            if len(clean(str(e.get("description", "")))) > len(clean(str(best.get("description", "")))):
                best["description"] = e.get("description", "")
            if not clean(str(best.get("rsvp_link", ""))) and clean(str(e.get("rsvp_link", ""))):
                best["rsvp_link"] = e.get("rsvp_link", "")
            merged_imgs: List[str] = []
            for row in (best, e):
                for u in (row.get("image_urls") or []):
                    uu = clean(str(u))
                    if uu and uu not in merged_imgs:
                        merged_imgs.append(uu)
            best["image_urls"] = merged_imgs[:8]
        source_types = sorted({source_type_of(x) for x in grp if source_type_of(x) != "other"})
        best["data_sources"] = source_types
        best["original_source_link"] = original_link
        cards.append(best)
    today = date.today().isoformat()
    def sort_key(x: Dict):
        d = clean(str(x.get("date", "")))
        t = clean(str(x.get("start_time", ""))) or "99:99"
        title = clean(str(x.get("title", "")))
        if d and d >= today:
            return (0, d, t, title)
        # past events after upcoming, most recent first
        d_num = 0
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            d_num = int(d.replace("-", ""))
        return (1, -d_num, t, title)
    cards.sort(key=sort_key)
    return cards


def backfill_images_by_title(cards: List[Dict]) -> List[Dict]:
    title_to_images: Dict[str, List[str]] = {}
    for c in cards:
        tk = title_key(str(c.get("title", "")))
        imgs = [clean(str(u)) for u in (c.get("image_urls") or []) if clean(str(u))]
        if tk and imgs and tk not in title_to_images:
            title_to_images[tk] = imgs
    out: List[Dict] = []
    for c in cards:
        row = dict(c)
        imgs = [clean(str(u)) for u in (row.get("image_urls") or []) if clean(str(u))]
        if not imgs:
            tk = title_key(str(row.get("title", "")))
            if tk in title_to_images:
                row["image_urls"] = title_to_images[tk]
        out.append(row)
    return out


def img_src(pathish: str) -> str:
    p = clean(pathish)
    if not p:
        return ""
    if p.startswith("http"):
        return p
    # Serve local assets via the same HTTP origin as the dashboard.
    p = p.lstrip("/")
    return "/" + p


def card_html(e: Dict) -> str:
    title = html.escape(clean(str(e.get("title", ""))) or "Untitled")
    date = html.escape(clean(str(e.get("date", ""))) or "-")
    st = clean(str(e.get("start_time", "")))
    et = clean(str(e.get("end_time", "")))
    tm = html.escape(st + (f" - {et}" if et else "")) if st else "Time TBD"
    loc = html.escape(clean(str(e.get("location_name", ""))))
    addr = html.escape(clean(str(e.get("address", ""))))
    srcs = ", ".join(e.get("data_sources", []))
    srcs = html.escape(srcs or "unknown")
    rsvp = clean(str(e.get("rsvp_link", "")))
    source_link = clean(str(e.get("original_source_link", "")))
    rsvp_html = f'<a href="{html.escape(rsvp)}" target="_blank" rel="noreferrer">RSVP</a>' if rsvp else "No RSVP link"
    source_html = (
        f'<a href="{html.escape(source_link)}" target="_blank" rel="noreferrer">Original Source</a>'
        if source_link
        else "Original source unavailable"
    )
    img = ""
    flyer_link = ""
    imgs = e.get("image_urls") or []
    if imgs:
        first = img_src(str(imgs[0]))
        if first:
            flyer_link = first
            img = (
                f'<a class="poster-wrap" href="{html.escape(first)}" target="_blank" rel="noreferrer">'
                f'<img class="poster" src="{html.escape(first)}" alt="poster" />'
                "</a>"
            )
    flyer_html = (
        f'<a href="{html.escape(flyer_link)}" target="_blank" rel="noreferrer">View Full Flyer</a>'
        if flyer_link
        else "No flyer available"
    )
    return (
        '<article class="card">'
        f'{img}'
        '<div class="body">'
        f"<h3>{title}</h3>"
        f'<p class="meta"><b>{date}</b> | {tm}</p>'
        f'<p class="meta">{loc}</p>'
        f'<p class="meta">{addr}</p>'
        f'<p class="meta">Sources: {srcs}</p>'
        f'<p class="meta">{source_html}</p>'
        f'<p class="meta">{rsvp_html}</p>'
        f'<p class="meta">{flyer_html}</p>'
        "</div>"
        "</article>"
    )


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    sources = discover_dashboard_sources()
    report = {"sources": {}, "generated_files": {}}
    sections_html: List[str] = []
    for source in sources:
        rows = [e for e in load_json(EVENTS_DIR / f"{source}_events.json") if clean(str(e.get("date", "")))]
        summary = summarize(rows)
        cards = merged_cards(rows)
        cards = backfill_images_by_title(cards)
        report["sources"][source] = {"summary": summary, "cards": cards}
        cards_markup = "\n".join(card_html(c) for c in cards[:40])
        sections_html.append(
            f"""
            <section>
              <h2>{source.upper()} — Events (scraper, email, Instagram)</h2>
              <div class="stats">
                <div><b>Total</b><span>{summary['total']}</span></div>
                <div><b>Email</b><span>{summary['email']}</span></div>
                <div><b>Scraper</b><span>{summary['scraper']}</span></div>
                <div><b>Overlap</b><span>{summary['both_overlap']}</span></div>
                <div><b>Email Only</b><span>{summary['email_only']}</span></div>
                <div><b>Scraper Only</b><span>{summary['scraper_only']}</span></div>
              </div>
              <div class="grid">{cards_markup}</div>
            </section>
            """
        )

    page = f"""<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Masjid Events Dashboard</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#eef2ff;margin:0;padding:24px}}
h1{{margin:0 0 8px}} .sub{{opacity:.8;margin-bottom:20px}}
section{{margin:24px 0 36px}}
.stats{{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin:10px 0 18px}}
.stats>div{{background:#141c34;border:1px solid #22315f;padding:10px;border-radius:10px;display:flex;justify-content:space-between}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}}
.card{{background:#141c34;border:1px solid #22315f;border-radius:12px;overflow:hidden}}
.poster{{width:100%;height:220px;object-fit:cover;background:#0a0f1f;display:block}}
.body{{padding:12px}} h3{{margin:0 0 8px;font-size:16px}}
.meta{{margin:3px 0;font-size:13px;opacity:.92}} a{{color:#8ec5ff}}
</style></head>
<body>
  <h1>Masjid Events Dashboard</h1>
  <p class="sub">Per-masjid feeds from website scrapers, email, and Instagram (merged). One section per source JSON.</p>
  {''.join(sections_html)}
</body></html>"""

    REPORT_HTML.write_text(page, encoding="utf-8")
    REPORT_JSON.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[dashboard] html={REPORT_HTML}")
    print(f"[dashboard] json={REPORT_JSON}")


if __name__ == "__main__":
    main()

