import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';

chromium.use(StealthPlugin());
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImageBuffer } from '../lib/cloudinary.js';
import { Recipe } from '../models/Recipe.js';

const TARGETS = [
  { url: 'https://www.justonecookbook.com/chicken-teriyaki/', site: 'justonecookbook', label: 'Chicken Teriyaki' },
  { url: 'https://www.justonecookbook.com/homemade-chashu-miso-ramen/', site: 'justonecookbook', label: 'Miso Ramen (Chashu)' },
  { url: 'https://www.justonecookbook.com/onigiri-rice-balls/', site: 'justonecookbook', label: 'Onigiri' },
];

function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const CONSENT_SELECTORS = [
  'button[id*="accept"]',
  'button[class*="accept"]',
  'button[aria-label*="Accept"]',
  '[id*="cookie"] button',
  '[class*="consent"] button',
];

async function scrapePage(browser, url) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });

    for (const sel of CONSENT_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 })) {
          await btn.click();
          await page.waitForTimeout(500);
          break;
        }
      } catch { /* not found */ }
    }

    await page.waitForSelector('.wprm-recipe, .tasty-recipes, article, main', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const text = await page.evaluate(() => document.body.innerText);
    const imageUrl = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      return og?.content ?? null;
    });

    // Fetch image from inside the browser page — inherits cookies and CDN auth
    let imageBuffer = null;
    if (imageUrl) {
      try {
        const bytes = await page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return null;
          return Array.from(new Uint8Array(await r.arrayBuffer()));
        }, imageUrl);
        if (bytes) {
          const buf = Buffer.from(bytes);
          // Validate magic bytes: JPG=FF, PNG=89, WebP=52 ('R'), GIF=47 ('G')
          const isImage = buf[0] === 0xFF || buf[0] === 0x89 || buf[0] === 0x52 || buf[0] === 0x47;
          imageBuffer = isImage ? buf : null;
        }
      } catch { /* image fetch failed — will skip upload */ }
    }

    return { text, imageUrl, imageBuffer };
  } finally {
    await page.close();
    await context.close();
  }
}

// Pull out any Asian culinary keywords Gemini noted in the ingredients
function detectSpecialtyIngredients(ingredients = []) {
  const keywords = ['miso', 'dashi', 'koji', 'tare', 'sake', 'mirin', 'shio', 'kombu', 'bonito', 'katsuobushi'];
  return ingredients
    .filter(i => keywords.some(k => i.name?.toLowerCase().includes(k) || i.notes?.toLowerCase().includes(k)))
    .map(i => i.name);
}

async function processOne({ url, site, label }) {
  const start = Date.now();
  const result = { label, url, ingredientCount: 0, imageSuccess: false, asianName: null, specialtyIngredients: [], error: null };

  try {
    console.log(`\n▶ ${label}`);
    console.log(`  Scraping ${url}...`);
    // Fresh browser per URL so Cloudflare sees a distinct fingerprint each time
    const browser = await chromium.launch({ headless: true });
    const { text, imageUrl: rawImageUrl, imageBuffer } = await scrapePage(browser, url);
    await browser.close();
    console.log(`  Page text: ${text.length} chars`);

    console.log(`  Extracting via Gemini...`);
    const extracted = await extractRecipe(text);

    const JUNK_TITLES = ['error', 'not found', 'blocked', 'access denied', 'no recipe'];
    if (!extracted.title || JUNK_TITLES.some(j => extracted.title.toLowerCase().includes(j))) {
      throw new Error(`Bad title "${extracted.title}". Page preview: ${text.slice(0, 150).replace(/\n/g, ' ')}`);
    }

    result.asianName = extracted.asianName;
    result.ingredientCount = extracted.ingredients?.length ?? 0;
    result.specialtyIngredients = detectSpecialtyIngredients(extracted.ingredients);

    const slug = toSlug(extracted.title);

    console.log(`  Uploading image to Cloudinary...`);
    let imageUrl = null;
    try {
      // Use the browser-downloaded buffer — bypasses CDN hotlink protection reliably
      imageUrl = await uploadRecipeImageBuffer(imageBuffer, slug);
      result.imageSuccess = !!imageUrl;
      console.log(`  Image: ${imageUrl}`);
    } catch (imgErr) {
      console.log(`  ⚠ Image upload failed: ${imgErr.message}`);
    }

    // Log the full extracted JSON for inspection
    console.log(`\n  Extracted JSON:\n${JSON.stringify(extracted, null, 2)
      .split('\n').map(l => '  ' + l).join('\n')}`);

    console.log(`\n  Saving to MongoDB...`);
    await Recipe.findOneAndUpdate(
      { slug },
      { ...extracted, slug, imageUrl, sourceUrl: url, sourceSite: site, scrapedAt: new Date() },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    console.log(`  ✓ Saved (${formatMs(Date.now() - start)})`);
  } catch (err) {
    result.error = err.message;
    console.log(`  ✗ Failed: ${err.message}`);
  }

  result.elapsed = Date.now() - start;
  return result;
}

function printSummaryTable(results) {
  console.log('\n' + '═'.repeat(100));
  console.log('DAY 4 SUMMARY — Just One Cookbook');
  console.log('═'.repeat(100));
  console.log(
    'Title'.padEnd(22) +
    'Ingredients'.padEnd(13) +
    'Asian Name'.padEnd(18) +
    'Specialty Ingredients Found'.padEnd(38) +
    'Img'.padEnd(5) +
    'Time'
  );
  console.log('─'.repeat(100));
  for (const r of results) {
    const specialty = r.specialtyIngredients.length
      ? r.specialtyIngredients.slice(0, 3).join(', ') + (r.specialtyIngredients.length > 3 ? '…' : '')
      : r.error ? `✗ ${r.error.slice(0, 30)}` : '—';
    console.log(
      r.label.padEnd(22) +
      String(r.ingredientCount).padEnd(13) +
      (r.asianName ?? '—').padEnd(18) +
      specialty.padEnd(38) +
      (r.imageSuccess ? 'Y' : 'N').padEnd(5) +
      formatMs(r.elapsed)
    );
  }
  console.log('═'.repeat(100));
  const ok = results.filter(r => !r.error).length;
  console.log(`${ok}/${results.length} recipes saved.`);
}

async function run() {
  await connectMongo();
  console.log('MongoDB connected.\n');

  const results = [];
  for (const target of TARGETS) {
    const result = await processOne(target);
    results.push(result);
    if (target !== TARGETS.at(-1)) await new Promise(r => setTimeout(r, 5_000));
  }

  await disconnectMongo();
  printSummaryTable(results);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
