import 'dotenv/config';
import { chromium } from 'playwright';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImage } from '../lib/cloudinary.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

const SITE = 'hk01';
const TASK_DELAY_MS = 2500;
const PAGE_TIMEOUT_MS = 60000;
const MAX_TASKS_PER_RUN = Number(process.env.SCRAPE_BATCH_LIMIT ?? 5);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(rawUrl || '').split('#')[0].split('?')[0].trim();
  }
}

function normalizeImageUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function extractHk01Id(url) {
  const match = url.match(/\/(\d+)(?:\/|$)/);
  return match?.[1] ?? null;
}

async function buildUniqueSlug(url, title, excludeRecipeId = null) {
  const numericId = extractHk01Id(url);
  const titleSlug = slugify(title);
  const candidates = [];

  if (numericId && titleSlug) {
    candidates.push(`${titleSlug}-${numericId}`);
  }
  if (numericId) {
    candidates.push(`hk01-${numericId}`);
  }
  if (titleSlug) {
    candidates.push(titleSlug);
  }
  candidates.push(`hk01-${Date.now()}`);

  for (const candidate of candidates) {
    const existing = await Recipe.findOne(
      excludeRecipeId
        ? { slug: candidate, _id: { $ne: excludeRecipeId } }
        : { slug: candidate },
      { _id: 1 }
    ).lean();

    if (!existing) {
      return candidate;
    }
  }

  return `hk01-${numericId ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function recipePayloadFromExtraction(extracted) {
  const payload = { ...extracted };
  delete payload.imageUrl;
  delete payload.images;
  return payload;
}

async function uploadCandidateImage(imageUrl, publicId) {
  if (!imageUrl) {
    return null;
  }

  try {
    return await uploadRecipeImage(imageUrl, publicId);
  } catch (error) {
    console.warn(`  Image upload failed for ${imageUrl}: ${error.message}`);
    return null;
  }
}

async function claimNextTask() {
  return Queue.findOneAndUpdate(
    {
      site: SITE,
      status: { $in: ['pending', 'failed'] },
      url: { $regex: '/教煮/' },
    },
    {
      $set: {
        status: 'processing',
        startedAt: new Date(),
      },
    },
    {
      sort: { priority: -1, createdAt: 1 },
      new: true,
    }
  );
}

async function extractPageData(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const pageData = await page.evaluate(() => {
    const readMeta = selector => {
      const node = document.querySelector(selector);
      const value = node?.getAttribute('content')?.trim();
      return value || null;
    };

    const jsonLdImages = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || 'null');
        const nodes = Array.isArray(data) ? data : data?.['@graph'] ?? [data];
        for (const node of nodes) {
          const image = node?.image;
          if (typeof image === 'string') {
            jsonLdImages.push(image);
            continue;
          }
          if (Array.isArray(image)) {
            for (const item of image) {
              if (typeof item === 'string') {
                jsonLdImages.push(item);
              } else if (item?.url) {
                jsonLdImages.push(item.url);
              }
            }
            continue;
          }
          if (image?.url) {
            jsonLdImages.push(image.url);
          }
        }
      } catch {
        // Ignore malformed JSON-LD blocks.
      }
    }

    const bodyText = document.body?.innerText || '';
    const title =
      readMeta('meta[property="og:title"]') ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.title ||
      null;

    return {
      title,
      bodyText,
      heroImage:
        readMeta('meta[property="og:image:secure_url"]') ||
        readMeta('meta[property="og:image"]') ||
        readMeta('meta[name="twitter:image"]') ||
        readMeta('meta[name="twitter:image:src"]') ||
        jsonLdImages[0] ||
        document.querySelector('article img')?.getAttribute('src') ||
        null,
      jsonLdImage: jsonLdImages[0] || null,
    };
  });

  return {
    title: pageData.title,
    rawText: pageData.bodyText,
    heroImage: normalizeImageUrl(pageData.heroImage, url),
    geminiImageFallback: normalizeImageUrl(pageData.jsonLdImage, url),
  };
}

async function markTask(queueId, status, lastError = null) {
  await Queue.findByIdAndUpdate(queueId, {
    $set: {
      status,
      lastError,
      processedAt: new Date(),
    },
  });
}

async function processTask(page, task) {
  const sanitizedUrl = sanitizeUrl(task.url);

  await Queue.findByIdAndUpdate(task._id, {
    $set: { url: sanitizedUrl },
  });

  const existingRecipe = await Recipe.findOne({ sourceUrl: sanitizedUrl }).lean();

  if (existingRecipe) {
    await markTask(task._id, 'skipped', 'Recipe already exists for sanitized URL');
    console.log(`  Skipped duplicate: ${sanitizedUrl}`);
    return;
  }

  console.log(`\nProcessing: ${sanitizedUrl}`);

  const { rawText, heroImage, geminiImageFallback } = await extractPageData(page, sanitizedUrl);

  if (!rawText || rawText.trim().length < 300) {
    await markTask(task._id, 'error', `Insufficient page content (${rawText?.trim().length ?? 0} chars)`);
    console.log('  Marked error: insufficient page content');
    return;
  }

  const extracted = await extractRecipe(rawText);
  if (!extracted) {
    await markTask(task._id, 'skipped', 'Gemini reported no recipe on page');
    console.log('  Marked skipped: no recipe found');
    return;
  }

  const recipeTitle = extracted.title?.trim();
  if (!recipeTitle) {
    await markTask(task._id, 'error', 'Gemini returned recipe without a title');
    console.log('  Marked error: missing recipe title');
    return;
  }

  const slug = await buildUniqueSlug(sanitizedUrl, recipeTitle);
  const geminiImage = normalizeImageUrl(extracted.imageUrl, sanitizedUrl) || geminiImageFallback;
  const uploadInputs = dedupeStrings([heroImage, geminiImage]);
  const uploadedImages = [];

  for (let index = 0; index < uploadInputs.length; index += 1) {
    const uploaded = await uploadCandidateImage(uploadInputs[index], `${slug}-${index}`);
    if (uploaded) {
      uploadedImages.push(uploaded);
    }
  }

  const imageUrl = dedupeStrings(uploadedImages);
  const payload = recipePayloadFromExtraction(extracted);

  await Recipe.updateOne(
    { sourceUrl: sanitizedUrl },
    {
      $set: {
        ...payload,
        slug,
        sourceUrl: sanitizedUrl,
        sourceSite: SITE,
        imageUrl,
        images: imageUrl,
        scrapedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  await markTask(task._id, 'completed', null);
  console.log(`  Completed: ${recipeTitle}`);
}

async function run() {
  await connectMongo();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-HK',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  const page = await context.newPage();

  try {
    console.log(`HK01 worker started on ${new Date().toISOString()} with batch limit ${MAX_TASKS_PER_RUN}`);

    let processedCount = 0;

    while (processedCount < MAX_TASKS_PER_RUN) {
      const task = await claimNextTask();
      if (!task) {
        console.log('No more matching HK01 queue tasks. Exiting.');
        break;
      }

      try {
        await processTask(page, task);
      } catch (error) {
        await markTask(task._id, 'error', error.message.slice(0, 500));
        console.error(`  Error: ${sanitizeUrl(task.url)} - ${error.message}`);
      }

      processedCount += 1;

      if (processedCount < MAX_TASKS_PER_RUN) {
        await sleep(TASK_DELAY_MS);
      }
    }

    if (processedCount >= MAX_TASKS_PER_RUN) {
      console.log(`Reached HK01 batch limit of ${MAX_TASKS_PER_RUN}. Exiting.`);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await disconnectMongo().catch(() => {});
  }

  process.exit(0);
}

run().catch(async error => {
  console.error(`Fatal: ${error.message}`);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
