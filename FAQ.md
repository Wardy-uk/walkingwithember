# FAQ - Walking With Ember

## What is this project?
This is the production website for Walking With Ember, built with Astro, content collections, and Netlify/Decap CMS.

## How do I run it locally?
1. `npm install`
2. `npm run dev`
3. Open `http://localhost:4321`

## How do I build for production?
- `npm run build`
- Output folder: `dist`

## Key dependencies
- `astro`
- `@astrojs/sitemap`
- `leaflet`
- `netlify-identity-widget`

## Important files
- `astro.config.mjs` (site URL and build config)
- `src/content.config.ts` (content schemas)
- `src/layouts/BaseLayout.astro` (global shell/SEO)
- `src/components/FlybyPanel.astro` (embedded 3D flyby)
- `src/lib/flybyCore.ts` (shared flyby math/utilities)
- `src/pages/admin/ai-walk.astro` (admin AI workflow UI)
- `netlify/functions/ai-create-post.mjs` (AI/GitHub commit function)

## Environment variables
Set these in Netlify and/or local `.env`:
- `PUBLIC_GA4_MEASUREMENT_ID`
- `PUBLIC_OS_MAPS_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional)
- `GITHUB_TOKEN`
- `GITHUB_REPO`
- `GITHUB_BRANCH` (optional)
- `SITE_BASE_URL` (optional)

## Domain/canonical URL
- Production site URL is set in `astro.config.mjs`.
- Keep this aligned with live domain for sitemap/canonical correctness.

## Domain registrar
- Domain registration for this site is managed via `one.com`.

## How do I resume Codex in this repo?
From this folder, run:
- `codex resume`
Then select the latest session for this repo.

## Flyby code sync with standalone app
There is a standalone flyby app at `C:\Git\gpx flyby`.
If `flybyCore` changes there, sync into this repo:
- `powershell -ExecutionPolicy Bypass -File "C:\Git\gpx flyby\scripts\sync-flyby-core.ps1"`

## Known priorities / TODO
1. Remove manual media import step in `src/pages/admin/media.astro` and auto-import all selected Google Picker items once selection is confirmed.
2. Create an admin media library page to browse/search all images already available in site storage (`/uploads/images`) for reuse across pages.
3. Harden `publish_draft` path validation in `netlify/functions/ai-create-post.mjs` (normalize path, block traversal).
4. Decide whether identity details should remain in admin activity log in `src/pages/admin/ai-walk.astro`.
5. Keep `src/components/FlybyPanel.astro` and `src/lib/flybyCore.ts` in sync with standalone flyby behavior.
6. Add tests for flyby preset selection and map playback behavior.

## What should not be committed?
- `.env`
- backup env files (for example `.env.bak`)
- any file containing real API keys/tokens
