import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Queue } from '../models/Queue.js';

chromium.use(StealthPlugin());

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const MAX_PAGES = 30; // max paginated pages to follow per index

// Negative-filter exclusions — anything matching these is NOT a recipe URL
const EXCLUDED_SEGMENTS  = ['/category/', '/tag/', '/author/', '/page/', '/wp-content/', '/wp-admin/', '/feed/', '/search/', '/shop/', '/cart/', '/account/', '/visual-recipe-index/', '/filter/', '/wok-guide/', '/glossary/', '/guide/', '/cookbook/', '/about/', '/contact/', '/ingredients/', '/kitchenware/', '/utensils/', '/tools/', '/equipment/', '/pantry/', '/recipes/', '/all-recipes/', '/vietnamese/', '/blog/'];
const EXCLUDED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.zip', '.xml', '.rss'];

const SITES = [
  // Tier 1 — dedicated Asian cuisines
  { site: 'woksoflife',      indexUrl: 'https://thewoksoflife.com/recipe-index/',           domain: 'woksoflife.com'       },
  { site: 'justonecookbook', indexUrl: 'https://www.justonecookbook.com/recipe-index/',      domain: 'justonecookbook.com'  },
  { site: 'maangchi',        indexUrl: 'https://www.maangchi.com/recipes',                  domain: 'maangchi.com'         },
  { site: 'hungryhuy',       indexUrl: 'https://www.hungryhuy.com/vietnamese/',             domain: 'hungryhuy.com'        },
  { site: 'hotthaikitchen',  indexUrl: 'https://hot-thai-kitchen.com/all-recipes/',         domain: 'hot-thai-kitchen.com' },
  // Tier 2 — general Asian / fusion
  { site: 'vickypham',       indexUrl: 'https://www.vickypham.com/',                        domain: 'vickypham.com'        },
  { site: 'recipetineats',   indexUrl: 'https://www.recipetineats.com/category/chinese-2/', domain: 'recipetineats.com'    },
];

function isRecipeUrl(rawHref, domain) {
  let url;
  try { url = new URL(rawHref); } catch { return false; }
  // Must belong to the same domain (handles www. vs apex variants)
  if (!url.hostname.endsWith(domain)) return false;
  // No query strings — structural/tracking URLs always have these
  if (url.search) return false;
  const path = url.pathname;
  // Skip root and very short paths (tag clouds, bare categories)
  if (path.length < 5) return false;
  // Not a media file
  if (EXCLUDED_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))) return false;
  // Not a structural page
  if (EXCLUDED_SEGMENTS.some(seg => path.includes(seg))) return false;
  return true;
}

function normalise(href) {
  // Strip fragments; ensure trailing slash for consistency
  return href.replace(/#.*$/, '').replace(/\/?$/, '/');
}

async function crawlSite({ site, indexUrl, domain }) {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();

  const collected = new Set();
  let currentUrl = indexUrl;
  let pageNum = 0;

  try {
    while (currentUrl && pageNum < MAX_PAGES) {
      pageNum++;
      console.log(`  [${site}] page ${pageNum}: ${currentUrl}`);

      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Wait for content to materialise (handles Cloudflare JS challenges on smaller sites)
      await page.waitForFunction(
        () => document.body.innerText.trim().length > 200,
        { timeout: 15_000 }
      ).catch(() => {});

      // Scroll to bottom to trigger any lazy-loaded recipe cards
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1_000);

      // Pull every anchor from the main content area
      const links = await page.evaluate(() => {
        const root = document.querySelector(
          'main, #content, .content, .site-main, .entry-content, article, body'
        ) ?? document.body;
        return [...root.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean);
      });

      let newCount = 0;
      for (const link of links) {
        if (isRecipeUrl(link, domain)) {
          const clean = normalise(link);
          if (!collected.has(clean)) { collected.add(clean); newCount++; }
        }
      }
      console.log(`    → +${newCount} new (total: ${collected.size})`);

      // Follow rel="next" or common WordPress/theme next-page patterns
      const nextHref = await page.evaluate(() => {
        const el = document.querySelector(
          'a[rel="next"], .next-page a, .pagination .next a, ' +
          'a.next, [class*="pagination"] a[class*="next"], ' +
          '.nav-links .next'
        );
        return el?.href ?? null;
      });

      currentUrl = (nextHref && nextHref !== currentUrl) ? nextHref : null;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return [...collected].map(url => ({ url, site }));
}

async function seed() {
  await connectMongo();

  let totalNew = 0;
  let totalExisting = 0;

  for (const siteConfig of SITES) {
    console.log(`\nCrawling ${siteConfig.site} …`);
    try {
      const entries = await crawlSite(siteConfig);
      console.log(`  Found ${entries.length} recipe URLs`);

      if (entries.length === 0) continue;

      const ops = entries.map(({ url, site }) => ({
        updateOne: {
          filter: { url },
          update: { $setOnInsert: { url, site, status: 'pending', lastError: null } },
          upsert: true,
        },
      }));

      const result = await Queue.bulkWrite(ops);
      totalNew      += result.upsertedCount;
      totalExisting += result.matchedCount;
      console.log(`  DB: +${result.upsertedCount} inserted, ${result.matchedCount} already queued`);
    } catch (err) {
      console.error(`  Error crawling ${siteConfig.site}: ${err.message.slice(0, 200)}`);
    }

    // Polite pause between sites
    await new Promise(r => setTimeout(r, 2_000));
  }

  console.log(`\n=== Seed complete: ${totalNew} new URLs, ${totalExisting} already existed ===`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
