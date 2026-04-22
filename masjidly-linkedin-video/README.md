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

Static files live in `public/` (served via `staticFile()`). They are copied from `safar-mobile/assets` (logos + tab bar icons). To swap in real app screenshots, add PNGs under `public/` and reference them in `src/MasjidlyLinkedIn.tsx`.

## LinkedIn

Upload the rendered MP4 as a video post. LinkedIn accepts 16:9; keep under 200MB. For a square or vertical variant, change `width` / `height` in `src/Root.tsx` and re-render.
