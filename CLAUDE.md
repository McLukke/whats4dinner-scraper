# Whats4Dinner Scraper — Technical Reference

## Project Purpose
Recipe scraper and aggregator. Hits recipe sites with Playwright, dumps raw page text into Gemini for structured extraction, persists to MongoDB Atlas, and mirrors images to Cloudinary.

## Tech Stack
| Layer | Tool | Notes |
|---|---|---|
| Scraping | Playwright (persistent context) | Avoids re-login; uses Chromium |
| AI Extraction | Gemini 2.5 Flash (`@google/generative-ai`) | Raw text → structured JSON |
| Storage | MongoDB Atlas via Mongoose | Upsert by `slug` to avoid dupes |
| Image CDN | Cloudinary v2 SDK | Uploaded to `whats4dinner/recipes/` folder |
| Config | `dotenv` | `.env` file, see `.env.example` |
| Runtime | Node.js 20, ES Modules (`"type": "module"`) | |
| CI | GitHub Actions cron (`.github/workflows/scrape.yml`) | Daily 2 AM UTC |

## Directory Layout
```
src/
  scrapers/      # Site-specific scrapers (extend baseScraper.js)
  lib/           # Singleton clients: mongo.js, gemini.js, cloudinary.js
  models/        # Mongoose schemas (Recipe.js)
  jobs/          # Entry-point scripts run by GitHub Actions (scrape.js)
.github/
  workflows/     # scrape.yml — cron job definition
playwright.config.js
.env.example
```

## Key Design Decisions

**AI-driven extraction over CSS selectors** — `src/lib/gemini.js` passes the full `document.body.innerText` to Gemini with a strict JSON schema prompt. This tolerates site layout changes without code updates.

**Persistent Playwright profile** — `chromium.launchPersistentContext('./playwright-profile')` preserves cookies and session state between runs. The profile directory is gitignored.

**Upsert by slug** — `Recipe.findOneAndUpdate({ slug }, data, { upsert: true })` means re-running the job is safe and idempotent.

**Batched concurrency** — `SCRAPE_CONCURRENCY` (default 3) controls how many URLs are processed in parallel per batch to avoid rate limits.

## Environment Variables
See `.env.example`. All secrets are stored as GitHub Actions secrets for CI runs.

## Adding a New Site
1. Add target URLs to the `TARGETS` array in `src/jobs/scrape.js`.
2. If the site needs special interaction (login, infinite scroll), create `src/scrapers/<site>.js` extending `baseScraper.js`.
3. Test locally: `node src/jobs/scrape.js`

## Running Locally
```bash
cp .env.example .env   # fill in real keys
npx playwright install chromium
node src/jobs/scrape.js
```
