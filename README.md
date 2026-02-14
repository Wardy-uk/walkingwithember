# Walking with Ember (Astro + Decap CMS)

Multi-page walking website with browser-based CMS, ready for GitHub + Netlify.

## Includes

- Astro static site with multiple pages:
  - Home
  - Walks listing
  - Walk detail pages
  - Blog listing
  - Blog detail pages
  - About
  - Contact (Netlify Form)
  - Privacy
- Decap CMS at `/admin`
- Draft/Review/Publish workflow (`editorial_workflow`)
- Netlify Identity + Git Gateway compatible setup
- GA4 with cookie consent banner
- OS Maps API tile support on walk pages
- SEO basics: sitemap, robots, Open Graph, schema markup
- AI walk/blog generator at `/admin/ai-walk/` (admin login required)

## Local development

1. Install dependencies:
   - `npm install`
2. Start dev server:
   - `npm run dev`
3. Open:
   - `http://localhost:4321`

## Required environment variables

Set these in Netlify Site Settings > Environment Variables:

- `PUBLIC_GA4_MEASUREMENT_ID`
- `PUBLIC_OS_MAPS_API_KEY`

### Additional variables for AI post generation

- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (optional, defaults to `gpt-4o-mini`)
- `GITHUB_TOKEN` (required, repo write access)
- `GITHUB_REPO` (required, format: `owner/repo`)
- `GITHUB_BRANCH` (optional, defaults to `main`)
- `SITE_BASE_URL` (optional, used for absolute GPX links)

You can also set them locally in `.env`.

## Update your production URL

Replace `https://example.com` with your real domain in:

- `astro.config.mjs` (`site`)
- `public/robots.txt` (`Sitemap`)

## Deploy to Netlify from GitHub

1. Push repo to GitHub:
   - `git init`
   - `git add .`
   - `git commit -m "Initial Walking with Ember build"`
   - `git branch -M main`
   - `git remote add origin <your-github-repo-url>`
   - `git push -u origin main`
2. Netlify:
   - Add new site -> Import from Git
   - Provider: GitHub
   - Build command: `npm run build`
   - Publish directory: `dist`
3. Deploy.

## Enable CMS login for technical + non-technical editors

In Netlify for this site:

1. Enable **Identity**.
2. Under Identity settings, enable **Git Gateway**.
3. Invite editors by email in Identity.
4. Editors sign in at `/admin`.

## CMS collections

- Walks (`src/content/walks`)
- Blog (`src/content/blog`)
- Pages (`src/content/pages`)
- Site Settings (`src/content/settings/site.json`)

## AI creator workflow

1. Log into `/admin`.
2. Open **AI Walk Creator**.
3. Upload one GPX + one or more photos.
4. Fill route/reflection questions.
5. Choose output mode: walk, blog, or both.
6. Tool commits assets and draft markdown posts to GitHub.

## Important files

- `public/admin/config.yml` Decap CMS config
- `src/content.config.ts` content schemas
- `src/pages/` site routes
- `src/layouts/BaseLayout.astro` base SEO/layout shell
- `netlify.toml` Netlify build and headers
- `src/pages/admin/ai-walk.astro` AI creation UI
- `netlify/functions/ai-create-post.mjs` AI generation + GitHub commit endpoint