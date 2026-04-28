import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImageBuffer, uploadRecipeImage } from '../lib/cloudinary.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

chromium.use(StealthPlugin());

const BATCH_SIZE    = Number(process.env.SCRAPE_CONCURRENCY ?? 5);
const HEADLESS      = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const SITE_FILTER   = process.env.SCRAPE_SITE ?? null;   // e.g. SCRAPE_SITE=maangchi
const MAX_IMAGES    = 3;
const SCRAPE_TIMEOUT_MS = 90_000; // hard kill per URL — prevents GitHub Action stalls

const JUNK_TITLES = ['error', 'not found', 'blocked', 'access denied', 'no recipe', 'page not found', '404'];

const CONSENT_SELECTORS = [
  'button[id*="accept"]',
  'button[class*="accept"]',
  'button[aria-label*="Accept"]',
  '[id*="cookie"] button',
  '[class*="consent"] button',
  'text=Accept',
  'text=同意',
];

function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function isImageBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  // Magic bytes: JPG=FF D8, PNG=89 50, WebP=52 49 ('RI'), GIF=47 49 ('GI')
  return buf[0] === 0xFF || buf[0] === 0x89 || buf[0] === 0x52 || buf[0] === 0x47;
}

function extractYouTubeId(url) {
  return url?.match(/(?:embed\/|v=|youtu\.be\/)([^?&/]+)/)?.[1] ?? null;
}

// Returns a canonical embed URL for easy frontend <iframe> use
// Handles: youtube.com/embed/ID, youtube.com/watch?v=ID, youtu.be/ID, vimeo player URLs
function normalizeVideoUrl(rawSrc) {
  if (!rawSrc) return null;
  const ytId = rawSrc.match(/youtube(?:-nocookie)?\.com\/embed\/([^?&/]+)/)?.[1]
            ?? rawSrc.match(/(?:youtube\.com\/watch[?&]v=|youtu\.be\/)([^?&/]+)/)?.[1];
  if (ytId) return `https://www.youtube.com/embed/${ytId}`;
  const vimeoId = rawSrc.match(/player\.vimeo\.com\/video\/(\d+)/)?.[1]
               ?? rawSrc.match(/vimeo\.com\/(\d+)/)?.[1];
  if (vimeoId) return `https://player.vimeo.com/video/${vimeoId}`;
  return rawSrc;
}

// Runs inside the page: collects og:image/twitter:image, up to 3 content images, and first video embed
async function collectMediaUrls(page) {
  return page.evaluate(() => {
    // Metadata tags are always high-res, non-lazy-loaded, and people-free — use as priority source
    const ogImage = document.querySelector('meta[property="og:image"]')?.content
                 ?? document.querySelector('meta[name="twitter:image"]')?.content
                 ?? document.querySelector('meta[name="twitter:image:src"]')?.content
                 ?? null;

    // Resolve iframe src — handles both eager and lazy-loaded embeds (data-src)
    function iframeSrc(el) {
      return el?.src || el?.dataset?.src || el?.dataset?.lazySrc || null;
    }

    // YouTube/Vimeo/Mediavine — check live src AND data-src for lazy-loaders
    const videoEl = document.querySelector(
      'iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"], ' +
      'iframe[src*="youtu.be"], iframe[src*="vimeo.com"], iframe[src*="mediavine"], ' +
      'iframe[data-src*="youtube.com/embed"], iframe[data-src*="youtube-nocookie.com/embed"], ' +
      'iframe[data-src*="youtu.be"], iframe[data-src*="vimeo.com"]'
    );
    let videoUrl = iframeSrc(videoEl);

    // Fallback: YouTube anchor links (some sites link instead of embed)
    if (!videoUrl) {
      const ytLink = document.querySelector('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
      videoUrl = ytLink?.href ?? null;
    }

    // Images from the recipe content block, filtering out tracking pixels, icons, and human shots
    const contentRoot = document.querySelector(
      '.wprm-recipe, .tasty-recipes, .recipe-card, [class*="recipe"], article, main'
    ) ?? document.body;

    const JUNK_URL    = /(logo|icon|avatar|pixel|1x1|tracking|gravatar|spinner|blank)/i;
    const HUMAN_URL   = /(chef|author|biography|profile|portrait)/i;

    const contentImageUrls = [...contentRoot.querySelectorAll('img')]
      .filter(img => {
        const src = img.src || img.dataset.src || img.dataset.lazySrc || '';
        if (!src || !/^https?:\/\/.+\.(jpe?g|png|webp|gif)/i.test(src)) return false;
        if (JUNK_URL.test(src) || HUMAN_URL.test(src)) return false;
        if (HUMAN_URL.test(img.alt || '')) return false;
        // Reject portrait-oriented images — food shots are landscape; person shots are portrait
        if (img.naturalWidth > 0 && img.naturalHeight > img.naturalWidth) return false;
        return true;
      })
      .map(img => img.src || img.dataset.src || img.dataset.lazySrc || '');

    return { ogImage, videoUrl, contentImageUrls };
  });
}

async function downloadImageInPage(page, src) {
  try {
    const bytes = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return null;
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, src);
    if (!bytes) return null;
    const buf = Buffer.from(bytes);
    return isImageBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

async function scrapePage(url) {
  const browser = await chromium.launch({ headless: HEADLESS });

  // Hard timeout — closes the browser which aborts all in-flight page ops
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    browser.close().catch(() => {});
  }, SCRAPE_TIMEOUT_MS);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-HK',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    for (const sel of CONSENT_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 })) { await btn.click(); break; }
      } catch { /* not present */ }
    }

    // Wait for JS challenge / lazy content to resolve
    await page.waitForFunction(
      () => document.body.innerText.trim().length > 500,
      { timeout: 30_000 }
    ).catch(() => {});

    await page.waitForSelector('.wprm-recipe, .tasty-recipes, article, main', { timeout: 8_000 }).catch(() => {});

    // Incremental scroll so images enter the viewport and lazy-loaders fire
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const step = 800; // matches viewport height
    for (let y = step; y < scrollHeight + step; y += step) {
      await page.evaluate((pos) => window.scrollTo(0, pos), y);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(800); // let final batch of lazy images resolve
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Strip structural noise and blog-fluff containers before text extraction
    await page.evaluate(() => {
      const selectors = [
        'header', 'footer', 'aside', 'nav',
        '.sidebar', '.widget', '.comments', '.comment-section', '.comment-list',
        '.ads', '.ad', '.adsbygoogle', '.advertisement',
        '.related-posts', '.related', '.newsletter', '.email-signup',
        '[class*="author"]', '[class*="social"]', '[class*="bio"]',
        '[class*="share"]', '[class*="subscribe"]', '[class*="popup"]',
        '[class*="promo"]', '[class*="banner"]',
        '[id*="author"]', '[id*="social"]', '[id*="comments"]', '[id*="sidebar"]',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }
    });

    const text = await page.evaluate(() => document.body.innerText);
    if (text.trim().length < 500) {
      throw new Error(`Insufficient page content (${text.trim().length} chars) — possible bot block`);
    }

    // --- Media collection ---
    const { ogImage, videoUrl: rawVideoUrl, contentImageUrls } = await collectMediaUrls(page);
    const videoUrl = normalizeVideoUrl(rawVideoUrl); // canonical embed URL, no query params

    // Deduplicate and cap at MAX_IMAGES candidates (og:image gets priority slot 0)
    const seen = new Set();
    const candidateUrls = [ogImage, ...contentImageUrls].filter(u => {
      if (!u || seen.has(u)) return false;
      seen.add(u);
      return true;
    }).slice(0, MAX_IMAGES);

    // YouTube thumbnail fallback fills any remaining slots
    const ytId = extractYouTubeId(rawVideoUrl);
    if (ytId && candidateUrls.length < MAX_IMAGES) {
      candidateUrls.push(`https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`);
    }

    // Download site images via the browser context (respects CDN cookies)
    const siteUrls = candidateUrls.filter(u => !u.includes('img.youtube.com'));
    const ytUrls   = candidateUrls.filter(u =>  u.includes('img.youtube.com'));

    const siteBuffers = await Promise.all(siteUrls.map(u => downloadImageInPage(page, u)));

    return { text, videoUrl, siteImagePairs: siteUrls.map((u, i) => ({ url: u, buffer: siteBuffers[i] })), ytImageUrls: ytUrls };
  } catch (err) {
    if (timedOut) throw new Error(`Scrape timeout after ${SCRAPE_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(killTimer);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function processItem(queueItem) {
  const { url, site, _id } = queueItem;

  const claimed = await Queue.findOneAndUpdate(
    { _id, status: 'processing' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' }
  );
  if (!claimed) return;

  try {
    console.log(`  Scraping: ${url}`);
    const { text, videoUrl, siteImagePairs, ytImageUrls } = await scrapePage(url);

    const extracted = await extractRecipe(text);

    if (!extracted) throw new Error('Gemini rejected page: no recipe content detected');
    if (!extracted.title || JUNK_TITLES.some(j => extracted.title.toLowerCase().includes(j))) {
      throw new Error(`Bad title: "${extracted?.title}"`);
    }

    const slug = toSlug(extracted.title);

    // Upload site images (browser-fetched buffers)
    const imageUploadResults = await Promise.all(
      siteImagePairs.map(({ buffer }, i) =>
        uploadRecipeImageBuffer(buffer, `${slug}-${i}`)
      )
    );

    // Upload YouTube thumbnails via axios (public CDN, no auth needed)
    const ytUploadResults = await Promise.all(
      ytImageUrls.map((ytUrl, i) =>
        uploadRecipeImage(ytUrl, `${slug}-yt-${i}`).catch(() => null)
      )
    );

    const images = [...imageUploadResults, ...ytUploadResults].filter(Boolean);
    console.log(`  Media: ${images.length} image(s)${videoUrl ? ', 1 video' : ''}`);

    await Recipe.findOneAndUpdate(
      { slug },
      { ...extracted, slug, images, videoUrl: videoUrl ?? null, sourceUrl: url, sourceSite: site, scrapedAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    await Queue.findByIdAndUpdate(_id, { status: 'completed', lastError: null, processedAt: new Date() });
    console.log(`  ✓ ${extracted.title}`);
  } catch (err) {
    await Queue.findByIdAndUpdate(_id, { status: 'failed', lastError: err.message.slice(0, 500), processedAt: new Date() });
    console.log(`  ✗ ${url} — ${err.message.slice(0, 120)}`);
  }
}

async function run() {
  await connectMongo();

  const siteQuery = SITE_FILTER ? { site: SITE_FILTER } : {};
  const pending = await Queue.find({ status: 'pending', ...siteQuery }).sort({ priority: -1, lastmod: -1, createdAt: 1 }).limit(BATCH_SIZE);

  if (pending.length === 0) {
    console.log('Queue is empty — nothing to process.');
    await disconnectMongo();
    return;
  }

  console.log(`Processing ${pending.length} queued URL(s) (batch size: ${BATCH_SIZE})...\n`);

  await Queue.updateMany(
    { _id: { $in: pending.map(p => p._id) } },
    { $set: { status: 'processing' } }
  );

  for (const item of pending) {
    item.status = 'processing';
    await processItem(item);
    if (item !== pending.at(-1)) await new Promise(r => setTimeout(r, 3_000));
  }

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('\nQueue status after run:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
  console.log('Done.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
