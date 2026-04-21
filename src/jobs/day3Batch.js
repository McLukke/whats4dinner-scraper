import 'dotenv/config';
import { chromium } from 'playwright';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImage } from '../lib/cloudinary.js';
import { Recipe } from '../models/Recipe.js';

const TARGETS = [
  { url: 'https://thewoksoflife.com/ma-po-tofu/',                            site: 'thewoksoflife', label: 'Mapo Tofu' },
  { url: 'https://thewoksoflife.com/chinese-bbq-pork-cha-siu/',              site: 'thewoksoflife', label: 'Char Siu BBQ Pork' },
  { url: 'https://thewoksoflife.com/cantonese-soy-sauce-pan-fried-noodles/', site: 'thewoksoflife', label: 'Soy Sauce Noodles' },
  { url: 'https://thewoksoflife.com/shanghai-style-braised-pork-belly/',     site: 'thewoksoflife', label: 'Shanghai Pork Belly' },
  { url: 'https://thewoksoflife.com/chili-oil/',                             site: 'thewoksoflife', label: 'Chili Oil' },
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
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });

    // Dismiss cookie / consent modals so they don't eat into body text
    for (const sel of CONSENT_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 })) {
          await btn.click();
          await page.waitForTimeout(500);
          break;
        }
      } catch { /* selector not found — continue */ }
    }

    // Wait for recipe card to be present before grabbing text
    await page.waitForSelector('.wprm-recipe, .tasty-recipes, article, main', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);

    const text = await page.evaluate(() => document.body.innerText);
    const imageUrl = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      return og?.content ?? null;
    });
    return { text, imageUrl };
  } finally {
    await page.close();
  }
}

async function processOne(browser, { url, site, label }) {
  const start = Date.now();
  const result = { label, url, ingredientCount: 0, imageSuccess: false, chineseName: null, slug: null, error: null };

  try {
    console.log(`\n▶ ${label}`);
    console.log(`  Scraping...`);
    const { text, imageUrl: rawImageUrl } = await scrapePage(browser, url);

    console.log(`  Extracting via Gemini... (text: ${text.length} chars)`);
    const extracted = await extractRecipe(text);

    if (!extracted.title) {
      throw new Error(`Gemini returned null title. First 200 chars of page: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
    }

    result.chineseName = extracted.chineseName;
    result.ingredientCount = extracted.ingredients?.length ?? 0;

    const slug = toSlug(extracted.title);
    result.slug = slug;

    console.log(`  Uploading image to Cloudinary...`);
    const sourceImageUrl = extracted.imageUrl ?? rawImageUrl;
    let imageUrl = null;
    try {
      imageUrl = await uploadRecipeImage(sourceImageUrl, slug);
      result.imageSuccess = !!imageUrl;
    } catch (imgErr) {
      console.log(`  ⚠ Image upload failed: ${imgErr.message}`);
    }

    console.log(`  Saving to MongoDB...`);
    await Recipe.findOneAndUpdate(
      { slug },
      { ...extracted, slug, imageUrl, sourceUrl: url, sourceSite: site, scrapedAt: new Date() },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    console.log(`  ✓ Done (${formatMs(Date.now() - start)})`);
  } catch (err) {
    result.error = err.message;
    console.log(`  ✗ Failed: ${err.message}`);
  }

  result.elapsed = Date.now() - start;
  return result;
}

function printSummaryTable(results) {
  console.log('\n' + '═'.repeat(92));
  console.log('SUMMARY');
  console.log('═'.repeat(92));
  console.log(
    'Title'.padEnd(34) +
    'Ingredients'.padEnd(14) +
    'Chinese Name'.padEnd(22) +
    'Image'.padEnd(8) +
    'Time'
  );
  console.log('─'.repeat(92));
  for (const r of results) {
    const name = r.chineseName ?? '—';
    const status = r.error ? `✗ ${r.error.slice(0, 20)}` : (r.imageSuccess ? '✓' : '✗ no img');
    console.log(
      r.label.padEnd(34) +
      String(r.ingredientCount).padEnd(14) +
      name.padEnd(22) +
      (r.imageSuccess ? 'Y' : 'N').padEnd(8) +
      formatMs(r.elapsed)
    );
  }
  console.log('═'.repeat(92));
  const ok = results.filter(r => !r.error).length;
  console.log(`${ok}/${results.length} recipes saved successfully.`);
}

async function run() {
  await connectMongo();
  console.log('MongoDB connected.');

  const browser = await chromium.launchPersistentContext(
    process.env.USER_DATA_DIR ?? './playwright-profile',
    { headless: true }
  );

  const results = [];

  // Serial loop — one at a time to respect Gemini rate limits
  for (const target of TARGETS) {
    const result = await processOne(browser, target);
    results.push(result);
    // Brief pause between requests to avoid hammering Gemini
    if (target !== TARGETS.at(-1)) await new Promise(r => setTimeout(r, 2_000));
  }

  await browser.close();
  await disconnectMongo();

  printSummaryTable(results);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
