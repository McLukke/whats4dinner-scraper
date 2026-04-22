import 'dotenv/config';
import axios from 'axios';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Queue } from '../models/Queue.js';
import { Recipe } from '../models/Recipe.js';

chromium.use(StealthPlugin());

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const MAX_PAGES = 30;

// Structural page segments — anything containing these is NOT a recipe URL
const EXCLUDED_SEGMENTS  = ['/category/', '/tag/', '/author/', '/page/', '/wp-content/', '/wp-admin/', '/feed/', '/search/', '/shop/', '/cart/', '/account/', '/visual-recipe-index/', '/filter/', '/wok-guide/', '/glossary/', '/guide/', '/cookbook/', '/about/', '/contact/', '/ingredients/', '/kitchenware/', '/utensils/', '/tools/', '/equipment/', '/pantry/', '/recipes/', '/all-recipes/', '/vietnamese/', '/blog/'];
const EXCLUDED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.zip', '.xml', '.rss'];

// ---------------------------------------------------------------------------
// SITEMAP SITES — HTTP fetch + XML parse, no browser needed
// ---------------------------------------------------------------------------

const SITEMAP_SITES = [
  {
    site: 'christinesrecipes',
    // WordPress blog — tries sitemap_index first, falls back to sitemap.xml
    sitemapUrl: 'https://en.christinesrecipes.com/sitemap_index.xml',
    isRecipe: url =>
      url.includes('en.christinesrecipes.com') &&
      !/(sitemap|category|tag|search|feed|wp-content|wp-admin|\.xml|\.rss|\?|#)/.test(url) &&
      url.replace('https://en.christinesrecipes.com', '').split('/').filter(Boolean).length >= 1,
  },
  {
    site: 'daydaycook',
    sitemapUrl: 'https://www.daydaycook.com/sitemap_index.xml',
    isRecipe: url => url.includes('/en/recipes/') && !url.endsWith('/en/recipes/'),
  },
  {
    site: 'simplyrecipes',
    sitemapUrl: 'https://www.simplyrecipes.com/sitemap.xml',
    isRecipe: url =>
      url.includes('simplyrecipes.com') &&
      !/(\/tag\/|\/author\/|\/about|\/contact|sitemap|\/page\/|\/category\/|\?|#)/.test(url) &&
      url.replace('https://www.simplyrecipes.com', '').split('/').filter(Boolean).length >= 1,
  },
  {
    site: 'onceuponachef',
    sitemapUrl: 'https://www.onceuponachef.com/sitemap_index.xml',
    isRecipe: url => url.includes('onceuponachef.com/recipes/'),
  },
];

// ---------------------------------------------------------------------------
// PLAYWRIGHT SITES — browser crawl (existing Asian sites + new dynamic sites)
// ---------------------------------------------------------------------------

const PLAYWRIGHT_SITES = [
  // Existing — Asian cuisines
  { site: 'woksoflife',      indexUrl: 'https://thewoksoflife.com/recipe-index/',           domain: 'woksoflife.com'       },
  { site: 'justonecookbook', indexUrl: 'https://www.justonecookbook.com/recipe-index/',      domain: 'justonecookbook.com'  },
  { site: 'maangchi',        indexUrl: 'https://www.maangchi.com/recipes',                  domain: 'maangchi.com'         },
  { site: 'hungryhuy',       indexUrl: 'https://www.hungryhuy.com/vietnamese/',             domain: 'hungryhuy.com'        },
  { site: 'hotthaikitchen',  indexUrl: 'https://hot-thai-kitchen.com/all-recipes/',         domain: 'hot-thai-kitchen.com' },
  { site: 'vickypham',       indexUrl: 'https://www.vickypham.com/',                        domain: 'vickypham.com'        },
  { site: 'recipetineats',   indexUrl: 'https://www.recipetineats.com/category/chinese-2/', domain: 'recipetineats.com'    },

  // HK01 Cooking tag — Chinese-language articles; Gemini handles translation
  // Article URLs follow the pattern: hk01.com/<section>/<numeric-id>/<slug>
  {
    site: 'hk01',
    indexUrl: 'https://www.hk01.com/tag/%E6%95%99%E7%85%AE', // 教煮
    domain: 'hk01.com',
    recipeFilter: url => /hk01\.com\/[^/]+\/\d{5,}\//.test(url),
  },

  // Yahoo HK Cooking topic — mixed content; scraper will fail gracefully on non-recipe articles
  {
    site: 'yahoohk',
    indexUrl: 'https://hk.news.yahoo.com/topic/cooking',
    domain: 'hk.news.yahoo.com',
    recipeFilter: url => /hk\.news\.yahoo\.com\/[a-z0-9%_-]{12,}\.html$/.test(url),
  },
];

// ---------------------------------------------------------------------------
// Sitemap helpers — pure HTTP, no browser
// ---------------------------------------------------------------------------

async function fetchXml(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    timeout: 30_000,
    responseType: 'text',
  });
  return data;
}

function parseSitemapIndex(xml) {
  const locs = [];
  const re = /<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/g;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1]);
  return locs;
}

function parseSitemapUrls(xml) {
  const entries = [];
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const loc     = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    const lastmod = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? null;
    if (loc) entries.push({ url: loc, lastmod });
  }
  return entries;
}

async function crawlSitemap({ site, sitemapUrl, isRecipe }) {
  // Try the configured URL; if it 404s, flip between _index and plain
  let xml;
  try {
    xml = await fetchXml(sitemapUrl);
  } catch {
    const alt = sitemapUrl.includes('_index')
      ? sitemapUrl.replace('_index', '')
      : sitemapUrl.replace('.xml', '_index.xml');
    console.log(`  Primary sitemap failed, trying: ${alt}`);
    xml = await fetchXml(alt);
  }

  const isIndex = /<sitemapindex[\s>]/.test(xml) || /<sitemap>/.test(xml);
  let allEntries = [];

  if (isIndex) {
    const subUrls = parseSitemapIndex(xml);
    // Skip sub-sitemaps that are clearly not recipe content
    const recipeSubUrls = subUrls.filter(u => !/(image-|video-|news-|author|tag-)/.test(u));
    console.log(`  ${subUrls.length} sub-sitemaps found, checking ${recipeSubUrls.length} candidate(s)`);

    for (const subUrl of recipeSubUrls) {
      try {
        const subXml = await fetchXml(subUrl);
        allEntries.push(...parseSitemapUrls(subXml));
        await new Promise(r => setTimeout(r, 400));
      } catch (err) {
        console.log(`  Skipped sub-sitemap ${subUrl}: ${err.message.slice(0, 80)}`);
      }
    }
  } else {
    allEntries = parseSitemapUrls(xml);
  }

  const recipeEntries = allEntries.filter(({ url }) => isRecipe(url));
  console.log(`  ${allEntries.length} total URLs → ${recipeEntries.length} match recipe filter`);

  return recipeEntries.map(({ url, lastmod }) => ({
    url,
    site,
    lastmod: lastmod ? new Date(lastmod) : null,
  }));
}

// ---------------------------------------------------------------------------
// Playwright crawler (existing sites + HK01 / Yahoo HK)
// ---------------------------------------------------------------------------

function isRecipeUrl(rawHref, domain) {
  let url;
  try { url = new URL(rawHref); } catch { return false; }
  if (!url.hostname.endsWith(domain)) return false;
  if (url.search) return false;
  const path = url.pathname;
  if (path.length < 5) return false;
  if (EXCLUDED_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))) return false;
  if (EXCLUDED_SEGMENTS.some(seg => path.includes(seg))) return false;
  return true;
}

function normalise(href) {
  return href.replace(/#.*$/, '').replace(/\/?$/, '/');
}

async function crawlSite({ site, indexUrl, domain, recipeFilter }) {
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
      await page.waitForFunction(
        () => document.body.innerText.trim().length > 200,
        { timeout: 15_000 }
      ).catch(() => {});

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1_000);

      const links = await page.evaluate(() => {
        const root = document.querySelector(
          'main, #content, .content, .site-main, .entry-content, article, body'
        ) ?? document.body;
        return [...root.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean);
      });

      let newCount = 0;
      for (const link of links) {
        const valid = recipeFilter ? recipeFilter(link) : isRecipeUrl(link, domain);
        if (valid) {
          const clean = normalise(link);
          if (!collected.has(clean)) { collected.add(clean); newCount++; }
        }
      }
      console.log(`    → +${newCount} new (total: ${collected.size})`);

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

// ---------------------------------------------------------------------------
// Bulk-write helper — shared between sitemap and Playwright paths
// ---------------------------------------------------------------------------

async function upsertQueue(entries) {
  if (entries.length === 0) return { upsertedCount: 0, matchedCount: 0 };
  const ops = entries.map(({ url, site, lastmod }) => ({
    updateOne: {
      filter: { url },
      update: { $setOnInsert: { url, site, status: 'pending', lastError: null, lastmod: lastmod ?? null } },
      upsert: true,
    },
  }));
  return Queue.bulkWrite(ops);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed() {
  await connectMongo();

  // Pre-load already-scraped sourceUrls so we don't re-queue completed work
  const scraped = new Set((await Recipe.distinct('sourceUrl')).filter(Boolean));
  console.log(`Skipping ${scraped.size} already-scraped recipe URL(s).\n`);

  let totalNew = 0;
  let totalExisting = 0;

  // 1. Sitemap-based sites (Christine's, DayDayCook, Simply Recipes, Once Upon a Chef)
  for (const siteConfig of SITEMAP_SITES) {
    console.log(`\nSitemap → ${siteConfig.site}`);
    try {
      const entries = await crawlSitemap(siteConfig);
      const fresh = entries.filter(e => !scraped.has(e.url));
      console.log(`  ${fresh.length} new (${entries.length - fresh.length} already scraped)`);

      const result = await upsertQueue(fresh);
      totalNew      += result.upsertedCount;
      totalExisting += result.matchedCount;
      console.log(`  DB: +${result.upsertedCount} inserted, ${result.matchedCount} already queued`);
    } catch (err) {
      console.error(`  Failed: ${err.message.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 2_000));
  }

  // 2. Playwright-based sites (existing Asian sites + HK01 + Yahoo HK)
  for (const siteConfig of PLAYWRIGHT_SITES) {
    console.log(`\nCrawl → ${siteConfig.site}`);
    try {
      const entries = await crawlSite(siteConfig);
      const fresh = entries.filter(e => !scraped.has(e.url));
      console.log(`  ${entries.length} found, ${fresh.length} new`);

      const result = await upsertQueue(fresh);
      totalNew      += result.upsertedCount;
      totalExisting += result.matchedCount;
      console.log(`  DB: +${result.upsertedCount} inserted, ${result.matchedCount} already queued`);
    } catch (err) {
      console.error(`  Failed: ${err.message.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 2_000));
  }

  console.log(`\n=== Seed complete: ${totalNew} new URLs queued, ${totalExisting} already existed ===`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
