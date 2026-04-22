# Masjidly — LinkedIn showcase video (Remotion)

16:9 (1920×1080), 15s / 30fps. Uses app branding, logo, and tab icons only — no cat or animal imagery.

## Setup

```bash
cd masjidly-linkedin-video
npm install
```

## Preview

```bash
npm run dev
```

Open the `MasjidlyLinkedIn` composition in Remotion Studio.

## Render MP4

```bash
npm run render
```

Output: `out/masjidly-linkedin-1080p.mp4`

## Assets

- `public/icon.png` — app icon (intro).
- `public/screenshots/shot01.png` … `shot08.png` — **real iPhone simulator captures** from `../store-screenshots-1284x2778/`, copied in order. The composition maps:
  - Intro blur: `shot08`
  - Large phone: `shot01`
  - Three-up: `shot02`, `shot03`, `shot04`
  - CTA full-bleed: `shot05`  
  To use different frames, replace those PNGs or edit `SHOTS` in `src/MasjidlyLinkedIn.tsx`.

Re-copy from the repo with:

`cp store-screenshots-1284x2778/*.png public/screenshots/` (then rename to `shot01` … `shot08` in a stable order).

## LinkedIn

Upload the rendered MP4 as a video post. LinkedIn accepts 16:9; keep under 200MB. For a square or vertical variant, change `width` / `height` in `src/Root.tsx` and re-render.
