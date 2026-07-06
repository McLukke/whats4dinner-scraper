import 'dotenv/config';
import { chromium } from 'playwright';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Recipe } from '../models/Recipe.js';
import { uploadRecipeImage } from '../lib/cloudinary.js';

function normalizeImageUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;

  const trimmed = urlStr.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed.split('#')[0] || null;
  }
}

function isCloudinaryUrl(urlStr) {
  return typeof urlStr === 'string' && urlStr.includes('res.cloudinary.com');
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeImageUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

async function scrapeChristineHeroImage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1_500);

  return normalizeImageUrl(await page.evaluate(() => {
    const readMetaContent = (selector) => {
      const tag = document.querySelector(selector);
      const content = tag?.getAttribute('content')?.trim();
      return content || null;
    };

    const ogImage = readMetaContent('meta[property="og:image"]');
    if (ogImage) return ogImage;

    const twitterImage = readMetaContent('meta[name="twitter:image"]');
    if (twitterImage) return twitterImage;

    const postImg = document.querySelector('.post-body img, .entry-content img, article img, #main img');
    const imageSrc = postImg?.getAttribute('src') || postImg?.src || null;
    return imageSrc?.trim() || null;
  }));
}

function buildPublicId(doc) {
  const slugPart = (doc.slug || 'christinesrecipes').toString().trim() || 'christinesrecipes';
  return `${slugPart}-backfill-${doc._id}-0`;
}

async function resolveCloudinaryImage(doc, page) {
  const normalizedImages = dedupeStrings([
    ...toArray(doc.images),
    ...toArray(doc.imageUrl),
  ]);

  if (normalizedImages.length > 0) {
    const first = normalizedImages[0];
    if (isCloudinaryUrl(first)) {
      return normalizedImages;
    }

    const uploaded = await uploadRecipeImage(first, buildPublicId(doc));
    return uploaded ? [uploaded] : [];
  }

  const sourceUrl = doc.sourceUrl || doc.url;
  if (!sourceUrl) return [];

  const scrapedImage = await scrapeChristineHeroImage(page, sourceUrl);
  if (!scrapedImage) return [];

  const uploaded = await uploadRecipeImage(scrapedImage, buildPublicId(doc));
  return uploaded ? [uploaded] : [];
}

async function run() {
  await connectMongo();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  });

  try {
    const docs = await Recipe.collection.find(
      {
        $or: [
          { sourceSite: 'christinesrecipes' },
          { source: 'christinesrecipes' },
        ],
      },
      {
        projection: {
          _id: 1,
          slug: 1,
          title: 1,
          sourceUrl: 1,
          url: 1,
          images: 1,
          imageUrl: 1,
        },
      }
    ).toArray();

    console.log(`Found ${docs.length} Christine's Recipes document(s).`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const doc of docs) {
      try {
        const needsFix =
          doc.imageUrl == null ||
          typeof doc.imageUrl === 'string' ||
          !Array.isArray(doc.imageUrl);

        if (!needsFix) {
          skipped++;
          continue;
        }

        const cloudinaryImages = await resolveCloudinaryImage(doc, page);
        if (cloudinaryImages.length === 0) {
          console.log(`SKIP  ${doc.slug || doc._id}  no image found`);
          skipped++;
          continue;
        }

        await Recipe.collection.updateOne(
          { _id: doc._id },
          {
            $set: {
              images: cloudinaryImages,
              imageUrl: cloudinaryImages,
              updatedAt: new Date(),
            },
          }
        );

        console.log(`OK    ${doc.slug || doc._id}  ${cloudinaryImages[0]}`);
        updated++;
      } catch (error) {
        console.log(`FAIL  ${doc.slug || doc._id}  ${error.message}`);
        failed++;
      }
    }

    console.log(`Done. Updated: ${updated}  Skipped: ${skipped}  Failed: ${failed}`);
  } finally {
    await browser.close();
    await disconnectMongo();
  }
}

run().catch(error => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
