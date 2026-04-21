# Masjidly — App Store listing

This is the copy we submit to App Store Connect. Tested against every character
limit Apple currently enforces (as of April 2026).

---

## App name (30 char max)

```
Masjidly
```
8 / 30. Leaves room if you ever want to localize (e.g. `Masjidly: Halaqas & Events`).

---

## Subtitle (30 char max)

Pick one. The first is the most action-oriented.

1. `Halaqas & events near you` — 25 / 30 ✅ **recommended**
2. `Find masjid events near you` — 27 / 30
3. `Halaqas, khutbahs & iqamah` — 26 / 30

---

## Promotional text (170 char max — editable without resubmission)

```
Find every Jumu'ah khutbah, weekend halaqa, and visiting-scholar program at masjids near you. Follow a masjid, get a reminder, never miss a reminder of Allah.
```
157 / 170.

---

## Keywords (100 char max, comma-separated, no spaces after commas)

```
masjid,mosque,halaqa,khutbah,islam,muslim,quran,ramadan,iftar,iqamah,qibla,jumma,tafsir,dawah
```
94 / 100.

Tips:
- Don't repeat words already in the name / subtitle (Apple indexes those).
- Each term is searched on its own — don't put full phrases.
- Lowercase everything. Apple ignores case.

---

## Description (4000 char max)

```
Masjidly is the easiest way to discover events, lectures, and programs at masjids near you. Built by Muslims, for Muslims.

Every Jumu'ah khutbah, youth halaqah, visiting-scholar program, community iftar, and tafsir circle at your local masjids — in one place, on your home screen.

— WHY MASJIDLY —

• Find halaqas nearby. One tap, not eleven Instagram accounts.
• Follow your masjid. Get a gentle reminder whenever they post a new event.
• Follow scholars. Know the moment Mufti Menk, Omar Suleiman, or a local imam you love is speaking within an hour of you.
• Map view. See every masjid and every event this week pinned to your map.
• Save events. Keep a tidy shortlist of what you're attending this weekend.
• Prayer & iqamah times. Pulled from each masjid's official schedule, not a generic calculator.
• Qibla compass. Simple, quiet, and always in your pocket.
• AI learning plans. Auto-curated event tracks for topics like Seerah, Fiqh, and Qur'an — so you know which three halaqas to go to this month for a deep dive.

— PRIVACY FIRST —

We don't sell your data. We don't track you across apps. We don't use advertising SDKs. Your email is optional — use most of Masjidly without ever creating an account.

— FOR MASJID ADMINS —

Want your masjid listed? Email support@masjidly.app and we'll add you, usually within a few days. Want to control your own listings or remove them? Same email. We respond to every message.

— ACCOUNT DELETION —

Full in-app account deletion is available in Settings → Account → Delete my account. Everything tied to your account is permanently removed within 7 days.

— QUESTIONS OR FEEDBACK —

We're a tiny, Muslim-owned team. We read every email — support@masjidly.app.

Built with salawat in mind. May it help you show up.
```
1883 / 4000. Plenty of room to grow.

---

## What's New (for each version) (4000 char max)

```
v1.0.1

- In-app account deletion (Settings → Account → Delete my account)
- Hosted privacy policy and support page
- Improved accessibility of the guided walkthrough
- Bug fixes and performance improvements

JazakAllahu khayran for using Masjidly. Spot a bug? Email support@masjidly.app.
```

---

## Support URL

```
https://ssaud1.github.io/masjidly/support.html
```

## Marketing URL (optional)

```
https://ssaud1.github.io/masjidly/
```

## Privacy Policy URL (required)

```
https://ssaud1.github.io/masjidly/privacy.html
```

## Copyright

```
© 2026 Masjidly.
```

## Age rating

Choose **4+**. No objectionable content. Location is used, but Apple doesn't
escalate that to a higher rating.

## Category

Primary: **Lifestyle**
Secondary: **Reference**

(If `Religion & Spirituality` exists as a sub-category in your region, that's
fine too. Lifestyle indexes better for discovery.)

## App Privacy questionnaire (what to check)

- **Data used to track you**: NONE
- **Data linked to you**:
  - Email (if you chose to register)
  - Device ID (for sending push notifications you opted into)
- **Data NOT linked to you**:
  - Coarse location (used on-device only for sorting)
  - Crash / diagnostic data
- **Third-party partners**: Expo (for push delivery), Railway (backend host).

This matches the `NSPrivacyCollectedDataTypes` block in
`safar-mobile/app.json` exactly.

## Sign-in requirement

Apple will ask: "Does your app require users to sign in?"
- Answer: **No**. Most of Masjidly works without an account.

## Account deletion

Apple will ask: "Does your app offer account creation?"
- Answer: **Yes**.
- Follow-up: "Does your app offer in-app account deletion?"
- Answer: **Yes**. Path: `Settings → Account → Delete my account`.

---

## Screenshots (you'll take these on-device)

Required: 6.7" (iPhone 15 Pro Max or 14 Plus). Apple uses these for all sizes.

Suggested 6 shots, in order:

1. **Home** — MASJIDLY wordmark, "Events tonight" card, nearby masjid chips.
2. **Map view** — Several pinned masjids around your home city.
3. **Masjid sheet** — Open an MCM sheet with upcoming events.
4. **Discover / Scholars** — The Scholars & Speakers directory.
5. **AI Learning Plans** — Calendar tab with a plan tile open.
6. **Profile / Settings** — Shows "Account" section with Delete my account.

For each screenshot, add a one-line headline in the App Store:

1. Every halaqa near you, on your home screen.
2. See every masjid within 25 miles.
3. Follow your masjid. Never miss a program.
4. Discover scholars you love.
5. AI-curated learning plans.
6. Privacy-first, account-deletion built-in.

---

## Review notes (sent to Apple's reviewer)

```
Masjidly is a directory app for Islamic community events. It has a fully
working guest experience — no login required — so Apple's review team can
browse events, open masjids, toggle theme, and use the map without creating
an account.

If you'd like to test the authenticated flow:

  Demo email:    demo@masjidly.app
  Demo password: masjidly1234

Account deletion is available at: Settings → Account → Delete my account.
It hits DELETE https://masjidly-api-production.up.railway.app/api/account and
permanently removes all associated data.

Thank you for reviewing — may it benefit your day.
```

(Create the `demo@masjidly.app` user in the backend before submitting.)
