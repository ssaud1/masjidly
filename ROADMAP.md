# Masjidly / Safar — Product Roadmap

## 0. What exists today (inventory)

**Mobile app (`safar-mobile/App.tsx`, Expo / React Native 0.81)**
- Tabs: Home, Explore (map + list), Calendar (month grid + export), Saved, Settings
- Welcome / onboarding / profile capture screens
- Event detail modal: poster hero, RSVP (going / interested), save, share, masjid follow, trust/confidence card, report-an-issue form
- Map: 24 NJ masjid pins with per-masjid initial logo chips + event count badges
- Filters: audience (all / brothers / sisters / family), quick filters, saved presets, radius, date range, source multi-select, search query, sort mode
- Themes: minera, midnight, neo, vitaria, inferno, emerald
- Streak tracking, referral code, deep links (`masjidly.app/invite/...`)
- Push registration (expo-notifications — Expo Go limited)
- Local cache: `AsyncStorage` (events + meta), stale-while-revalidate against `data_version`
- Secure auth tokens via `expo-secure-store`

**Backend (`safar_custom_app.py`, Flask)**
- `/api/meta` — sources list, counts, `data_version`
- `/api/events`, `/api/events/past`, `/api/events/<uid>`, `/api/events/<uid>/ics`
- `/api/auth/{register,login,logout,me}`
- `/api/profile` GET/PUT
- `/api/notifications/preview`
- `/api/moderation/report`, `/api/moderation/reports` GET/PUT
- `/api/source-health`
- `/api/cache/reload`
- `/api/chat` (LLM assistant hook)

**Data pipeline**
- 24 NJ masjids, ~2,100 events in cache
- Sources: Instagram scrape, per-masjid website scrapers, email ingest (Gmail IMAP w/ app password), manual sender-rule mapping, synthetic Jumu'ah filler
- Daily pipeline: `safar_daily_pipeline.py` + per-masjid refresh scripts
- Poster audit + source-health dashboard
- Supabase sync (`sync_supabase_events.py`)

**What's already working well**
- Fast cold start (local cache)
- Instant tab switching (memoized scenes)
- Strong visual identity (Masjidly wordmark, masjid-logo map pins)
- Comprehensive event data (time, speaker, poster, address, audience, RSVP link)

---

## 1. North star

Make Masjidly the **one app a Muslim in NJ opens every single day** — not once a week when they're bored. That requires daily-habit features (prayer, Qur'an streak, iqama) layered on top of the event discovery core.

---

## 2. The 50 features

Organized by theme. Each has **Pitch**, **Where**, and **Size** (S ≤ 1 day, M ≤ 3 days, L ≤ 1 week).

### A. Prayer & daily essentials — *the retention engine* (10)

1. **Prayer times widget on Home**
   - Pitch: 5 adhan cards with next-prayer countdown, based on user location + calc method.
   - Where: mobile (new Home section), backend `/api/prayer-times?lat&lng&method` (compute server-side via adhan-python).
   - Size: M.

2. **Iqama time overlay per masjid**
   - Pitch: Tap a masjid → see today's iqama for each prayer (pulled from their website / IG story / admin portal).
   - Where: pipeline (new `iqama_scraper.py` + `iqama_overrides.json`), mobile (masjid profile sheet).
   - Size: L.

3. **Pre-iqama push notification**
   - Pitch: "Asr iqama at MCNJ in 15 min" for followed masjids only.
   - Where: backend scheduler + Expo push.
   - Size: M.

4. **Qibla compass**
   - Pitch: Offline magnetometer-based arrow, works anywhere.
   - Where: mobile (`expo-sensors` Magnetometer).
   - Size: S.

5. **Qur'an page-a-day tracker**
   - Pitch: "You've read 34 pages this month — streak: 7 days." Mini hero card, links to Quran.com or local mushaf.
   - Where: mobile state + optional backend sync.
   - Size: M.

6. **Adhan audio preview**
   - Pitch: Tap any prayer time to hear a short adhan clip (Mishary, Makkah, etc.).
   - Where: mobile assets + Settings chooser.
   - Size: S.

7. **Hijri date display**
   - Pitch: Show Hijri date on Home hero and every event card.
   - Where: mobile (date util + `hijri-converter` polyfill).
   - Size: S.

8. **Silent-mode auto-toggle at masjid**
   - Pitch: Opt-in; when user enters a masjid geofence during prayer time, suggest silent mode (iOS Shortcuts deep link).
   - Where: mobile geofencing (`expo-location` background).
   - Size: L.

9. **Tasbih counter widget**
   - Pitch: Long-press Home counter icon → tap to dhikr 33/33/34; stored locally per-day.
   - Where: mobile only.
   - Size: S.

10. **Daily hadith / ayah card**
    - Pitch: One rotating card per day above Today events. Source: curated 40 Hadith + selected ayahs.
    - Where: backend JSON list, mobile card.
    - Size: S.

### B. Event discovery & planning (7)

11. **"Tonight after Maghrib" smart list**
    - Pitch: Auto-surface events starting within 2hrs of sunset, visible on Home 4–7 PM.
    - Where: mobile client-side filter + push at Maghrib.
    - Size: S.

12. **"Bring a friend" one-tap invite**
    - Pitch: Event detail has a "Invite 3 friends" button → prefilled SMS/WhatsApp with poster + time + deep link + "Save my seat."
    - Where: mobile `Share` with rich attachment.
    - Size: S.

13. **Event series detection**
    - Pitch: "Seerah MS class" posted 12 weeks → one card with "12 upcoming sessions" + bulk RSVP.
    - Where: pipeline (event-series clustering by title + source + cadence), mobile (series card).
    - Size: M.

14. **Drive time + traffic**
    - Pitch: "18 min drive · leave by 7:12 to make iqama" using Apple Maps ETA.
    - Where: mobile MapKit ETA API.
    - Size: M.

15. **Carpool matching**
    - Pitch: Toggle "I can drive" or "Need a ride" per event; shows masjid-mates in your ZIP.
    - Where: backend table + mobile chip UI (privacy gated: first name + ZIP only).
    - Size: L.

16. **Personal event score**
    - Pitch: Each card shows a one-line "why you'd like this": "Because you follow MCNJ + attended 3 similar classes."
    - Where: mobile scoring function over `events × userProfile × followedMasjids × rsvpHistory`.
    - Size: M.

17. **Calendar import (bulk)**
    - Pitch: "Add all events at my 3 followed masjids for next 30 days" → single ICS.
    - Where: backend `/api/events/bulk.ics?sources=...&until=...`, mobile Settings button.
    - Size: S.

### C. Social & community (8)

18. **Attendee visibility (opt-in)**
    - Pitch: "You + 4 friends going." Show first-name avatars from your follows.
    - Where: backend RSVP table joined with follow graph.
    - Size: M.

19. **Masjid follow feed**
    - Pitch: Dedicated "Following" tab-less view — a vertical timeline of followed masjid announcements (events + iqama changes + IG posts).
    - Where: mobile scene + backend feed endpoint.
    - Size: M.

20. **Event chat room (ephemeral)**
    - Pitch: 48hr chat auto-opens for attendees of the same event — "Who's driving from Paterson?"
    - Where: backend Ably/Supabase realtime, mobile minimal chat UI.
    - Size: L.

21. **Post-event reflection**
    - Pitch: 24hrs after event, push: "How was tonight's halaqa? Rate + share one benefit." Appears on the masjid profile as social proof.
    - Where: backend reflections table + moderation.
    - Size: M.

22. **"Bring a sister / brother" buddy system**
    - Pitch: Commit publicly to bring one non-attender friend per month; badge on profile when fulfilled.
    - Where: mobile profile state + soft accountability nudges.
    - Size: S.

23. **Find a halaqa near me**
    - Pitch: Weekly recurring halaqas filtered by topic (seerah, tajweed, Arabic, youth).
    - Where: pipeline tag extractor + mobile filter chip.
    - Size: M.

24. **Local scholar directory**
    - Pitch: Auto-extract speakers from events → profile page per scholar (bio, upcoming talks, past recordings).
    - Where: pipeline entity extraction + backend `speakers` table + mobile screen.
    - Size: L.

25. **Ummah map heatmap**
    - Pitch: Toggle on Explore map to show density of attending users per masjid this week (anonymized).
    - Where: mobile map heatmap + backend aggregates.
    - Size: M.

### D. Family & kids (4)

26. **Kids program filter**
    - Pitch: Ages 5–10 / 11–14 / 15–17 chips on Explore; surface Sunday schools, youth halaqas, MSA events.
    - Where: pipeline classifier + mobile filter.
    - Size: S.

27. **Family calendar sync**
    - Pitch: One family account, shared saved events, shared RSVPs. Parent approves kid's RSVP.
    - Where: backend households table + mobile switcher.
    - Size: L.

28. **Sunday school enrollment links**
    - Pitch: Every masjid's youth program has a prominent "Enroll now" CTA on the masjid profile.
    - Where: manual override file + mobile profile section.
    - Size: S.

29. **Kids mode**
    - Pitch: Fun UI with bigger icons, no modals, parental-locked settings; shows only family/kid events.
    - Where: mobile theme variant.
    - Size: M.

### E. Habits, spiritual growth & gamification (5)

30. **Jumu'ah streak**
    - Pitch: Check in at Jumu'ah to extend streak; 🔥 badge on profile. Broken streaks offer "make-up dua" reset.
    - Where: mobile check-in (geofence-verified) + backend.
    - Size: M.

31. **Masjid passport**
    - Pitch: Visit all 24 NJ masjids to collect a digital stamp; each masjid has a QR in lobby.
    - Where: mobile QR scan + profile passport page.
    - Size: M.

32. **Good deeds journal**
    - Pitch: End of day: "One good thing I did today" + sadaqah tracker ($ given).
    - Where: mobile only (private, local-first).
    - Size: S.

33. **Ramadan mode (seasonal)**
    - Pitch: Countdown to Ramadan; during Ramadan: iftar/suhoor times, taraweeh schedules per masjid, daily juz tracker.
    - Where: mobile seasonal theme + pipeline taraweeh scraper.
    - Size: L.

34. **Weekly ibadah scorecard**
    - Pitch: Sunday night private card: prayers tracked, pages read, halaqas attended. Shareable as image.
    - Where: mobile state aggregator + image composer.
    - Size: M.

### F. At-the-masjid experience (4)

35. **Masjid check-in (NFC / QR)**
    - Pitch: Tap your phone to an NFC tag near the shoe racks → counts toward attendance, streak, passport.
    - Where: mobile `expo-nfc` + QR fallback.
    - Size: M.

36. **Parking lot status**
    - Pitch: Crowd-sourced "lot 80% full right now" during Jumu'ah; updated by first 5 check-ins.
    - Where: backend per-masjid realtime counter.
    - Size: M.

37. **Live khutbah notes**
    - Pitch: During Jumu'ah, the imam (via admin portal) pushes 3 bullet key-takeaways post-khutbah — shown as a reel-style card.
    - Where: backend admin POST + mobile card.
    - Size: M.

38. **Donation button per masjid**
    - Pitch: Masjid profile has "Give $5" / "Sponsor iftar" one-tap (Stripe Connect to masjid's account).
    - Where: backend Stripe integration + masjid onboarding.
    - Size: L.

### G. Trust, moderation & verification (3)

39. **Verified masjid badge**
    - Pitch: Admin signs up → claim masjid → verify via email from masjid-owned domain → blue check.
    - Where: backend verification flow + mobile badge UI.
    - Size: M.

40. **Community corrections voting**
    - Pitch: If an event is reported by 3+ users as wrong, mark it "flagged — being verified" until confirmed.
    - Where: backend thresholds + mobile badge.
    - Size: S.

41. **Source freshness labels**
    - Pitch: Each card: "from Instagram · 4 hr ago" or "from masjid website · 3 days ago" with color (green/yellow/red).
    - Where: mobile card footer, already have source_type.
    - Size: S.

### H. Ramadan / Eid / Jumu'ah specials (4)

42. **Jumu'ah digest (Thursday night push)**
    - Pitch: "3 khateebs, 8 Jumu'ah times across your 5 closest masjids — tap to pick one."
    - Where: backend scheduled job + push.
    - Size: S.

43. **Eid prayer finder**
    - Pitch: 2 weeks before Eid, big hero card: all NJ Eid prayer times sorted by distance; RSVP + add to calendar.
    - Where: pipeline Eid detector + seasonal hero.
    - Size: M.

44. **Iftar finder**
    - Pitch: Live during Ramadan — "iftar at MCNJ in 12 min, 2.3mi." List view sorted by sunset.
    - Where: mobile filter + Ramadan-only UI.
    - Size: S.

45. **Taraweeh tracker**
    - Pitch: See nightly juz reading progress per masjid; filter by "full Qur'an" vs "8 raka'at."
    - Where: pipeline + masjid-provided data.
    - Size: M.

### I. Masjid admin portal (4)

46. **Admin web dashboard** (builds on `safar-react`)
    - Pitch: Masjid admins log in, edit their events, upload posters, set iqama, post khutbah notes.
    - Where: `safar-react` + backend admin endpoints + RBAC.
    - Size: L.

47. **Event poster auto-designer**
    - Pitch: Admin types title + speaker + date → app generates 5 poster templates in their masjid's brand color (from logo palette). Exports to IG 4:5.
    - Where: admin web + simple canvas/SVG templates.
    - Size: M.

48. **One-click import from Instagram**
    - Pitch: Admin pastes their IG handle → we pull recent posts → they confirm which are events. One-time "bless the scraper" flow.
    - Where: admin web + pipeline integration.
    - Size: M.

49. **Analytics for masjids**
    - Pitch: Admin sees: followers, event views, RSVPs, check-ins, top speakers. Weekly email.
    - Where: backend aggregates + admin web.
    - Size: M.

### J. Accessibility, language & reach (3)

50. **Arabic + Urdu + Turkish UI**
    - Pitch: Full i18n; RTL support for Arabic.
    - Where: mobile i18n layer (`i18n-js`), string tables, RTL flex tweaks.
    - Size: L.

51. **Voice event creation (admin)**
    - Pitch: "Hey Masjidly, schedule Maulana's talk Friday 8pm on Seerah" → LLM parses to structured event.
    - Where: admin web + `/api/chat` extended with tool-calls.
    - Size: M.

52. **Large-text / a11y pass**
    - Pitch: Respect iOS Dynamic Type, voice-over labels on every Pressable, proper contrast everywhere.
    - Where: mobile a11y sweep.
    - Size: S.

### K. Growth, referral & monetization (4)

53. **Referral with real incentive**
    - Pitch: Invite 3 friends who complete profile → unlock premium themes + priority notifications.
    - Where: backend referral graph + mobile reward UI.
    - Size: M.

54. **Masjid "Most Active Member" leaderboard (opt-in)**
    - Pitch: Monthly top 10 members by attendance at each masjid (opt-in, pseudonymous). Healthy community competition.
    - Where: backend + masjid profile leaderboard card.
    - Size: M.

55. **Sadaqah pool**
    - Pitch: Users pre-fund a wallet; events have optional "split $1 between 5 masjids' tonight program" button. Quarterly distribution.
    - Where: Stripe + backend ledger (regulatory care needed).
    - Size: L.

56. **Embeddable event widget**
    - Pitch: Any masjid website can drop a `<iframe>` showing their next 5 events styled to match.
    - Where: backend `/embed/<source>`, `safar-react` widget build.
    - Size: M.

### L. Travel & out-of-area (2)

57. **Expand to other metros**
    - Pitch: NYC, Philly, DFW next. User types ZIP on Home → app asks "we don't cover this yet — notify me when we do?" + lets them submit nearby masjids.
    - Where: pipeline multi-region, mobile location prompt.
    - Size: L.

58. **"Travel mode"**
    - Pitch: Departing from NJ? On arrival at new location, auto-detect + suggest nearest masjid + prayer times (offline-ready prayer data for top 500 cities).
    - Where: mobile location change detection + bundled prayer tables.
    - Size: M.

---

## 3. Suggested 30-day ship order

Two guiding rules:
1. **Retention features first** — prayer times + Hijri date + Jumu'ah digest push turn Masjidly from a "check weekly" app into a daily app.
2. **Trust & admin second** — verified badges + admin dashboard make masjids actively feed you data instead of you scraping.

**Week 1 (daily-habit core)**
- #1 Prayer times widget · #4 Qibla · #7 Hijri date · #10 Daily ayah/hadith · #11 Tonight after Maghrib · #41 Source freshness labels

**Week 2 (social proof + share loop)**
- #12 Bring a friend invite · #18 Attendee visibility · #16 Personal event score · #42 Jumu'ah digest push · #30 Jumu'ah streak

**Week 3 (iqama loop + admin foundations)**
- #2 Iqama overlay · #3 Pre-iqama push · #39 Verified masjid badge · #46 Admin web dashboard MVP (login + edit events only)

**Week 4 (family + Ramadan prep)**
- #26 Kids filter · #28 Sunday school enrollment links · #17 Bulk calendar import · #33 Ramadan mode scaffold

Skip for now (later quarters): #15 carpool, #20 event chat, #38 donations, #50 i18n, #55 sadaqah pool, #57 new metros. These are L's with regulatory / scale work better tackled after product-market fit in NJ is proven.

---

## 4. How to measure success

Track these weekly, starting today:
- **DAU / MAU ratio** — currently likely ~10%. Target after Week 1 prayer features: 35%.
- **% users who RSVP'd this week**
- **% events with ≥ 1 attendee** (proxy for catalog relevance)
- **# verified masjids / 24** (target 12/24 in Q1)
- **Avg sessions/day per user** (prayer features pull this to 3–5)
- **Share conversion**: `invites sent / invites that led to signup`
