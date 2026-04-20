# Masjidly Web

Masjidly is a React + Vite web app for browsing local masjid events from Supabase.

## Local setup

1. Copy env vars:

```bash
cp .env.example .env
```

2. Fill the values in `.env`:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

3. Install and run:

```bash
npm install
npm run dev
```

## Production build

```bash
npm run lint
npm run build
```

## Supabase notes

- The app reads from `public.events`.
- Ensure the table has a read policy for anon/authenticated users.
- Event ingestion is handled by your existing sync pipeline (`sync_supabase_events.py`).

## Included UX features

- Shareable filtered URLs
- Source-level radius filter
- Event dedupe guard in UI
- Report issue action on each event
- External links for RSVP and event pages
- Phase-2 placeholders: `Near me`, `Add to calendar`
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
