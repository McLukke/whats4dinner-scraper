import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImage } from '../lib/cloudinary.js';

dotenv.config({ path: '.env' });

const MAX_TASKS_PER_RUN = Number(process.env.SCRAPE_BATCH_LIMIT ?? 5);

// Helper to generate a URL-friendly slug and strip hashes
function generateSlug(urlStr, title) {
  try {
    const url = new URL(urlStr);
    const filename = url.pathname.split('/').pop(); // e.g. "shanghai-fried-noodles.html"
    const slug = filename.replace(/\.html$/, '').replace(/_/g, '-').trim().toLowerCase();
    if (slug && slug !== 'index' && slug !== 'default' && slug.length > 2) {
      return slug;
    }
  } catch (e) {
    // If URL parsing fails, fall back to title-based slugification
  }

  // Fallback slugification of the English title
  return title
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start
    .replace(/-+$/, '');            // Trim - from end
}

// Helper to clean hashes and query parameters out of a URL
function cleanUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    url.hash = ''; // Remove #comment-form, #more, etc.
    return url.toString();
  } catch (e) {
    return urlStr;
  }
}

function normalizeImageUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return null;
  }

  const trimmedUrl = urlStr.trim();
  if (!trimmedUrl) {
    return null;
  }

  try {
    const url = new URL(trimmedUrl);
    url.hash = '';
    return url.toString();
  } catch (e) {
    return trimmedUrl.split('#')[0] || null;
  }
}

function hasValidImageUrl(urlStr) {
  return Boolean(normalizeImageUrl(urlStr));
}

function toImageArray(...values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeImageUrl(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

async function runChristineWorker() {
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db();
    const queues = db.collection('queues');
    const recipes = db.collection('recipes');

    console.log(`🍏 Mac mini Local Worker Active: Targeting 'christinesrecipes' with batch limit ${MAX_TASKS_PER_RUN}...`);

    // Launch chromium with a clean desktop user agent to comfortably bypass Cloudflare
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    let processedCount = 0;

    while (processedCount < MAX_TASKS_PER_RUN) {
      // 1. Grab ONE pending or failed task specifically for Christine's Recipes
      // Defensive filter: Ignore search paths, category label lists, and static metadata/contact pages (/p/ pages)
      const task = await queues.findOneAndUpdate(
        { 
          site: "christinesrecipes", 
          status: { $in: ["pending", "failed"] },
          url: { 
            $not: /(\/search\/label\/|\/p\/)/ 
          }
        },
        { $set: { status: 'processing', startedAt: new Date() } },
        { sort: { priority: -1, createdAt: 1 }, returnDocument: 'after' }
      );

      // 🛑 THE KILL SWITCH: If no more matching tasks exist, shut down!
      if (!task) {
        console.log("\n🎉 All Christine's recipes have been processed successfully! Stopping script...");
        break;
      }

      // Clean the URL (remove hash components like #comment-form)
      const sanitizedUrl = cleanUrl(task.url);

      // Check if we already have this exact sanitized URL in our recipes collection
      const existingRecipe = await recipes.findOne({ url: sanitizedUrl });
      
      if (existingRecipe) {
        // If it already exists, mark this duplicate task as completed immediately and skip network scraping!
        await queues.updateOne({ _id: task._id }, { $set: { status: 'completed', lastError: 'Skipped duplicate hash URL' } });
        console.log(`  ♻️  Skipped Duplicate: Clean URL already exists in database. Link marked completed.`);
        continue;
      }

      try {
        console.log(`\n🎂 Processing (${task.status === 'failed' ? 'Retry' : 'New'}): ${task.url}`);
        
        // 2. Fetch the page with generous timeouts to allow Cloudflare challenges to settle
        await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        // Extract the main image URL directly from the DOM using Playwright
        const domImageUrl = normalizeImageUrl(await page.evaluate(() => {
          const readMetaContent = (selector) => {
            const tag = document.querySelector(selector);
            const content = tag?.getAttribute('content')?.trim();
            return content || null;
          };

          // Blogger usually exposes the main post image here.
          const ogImage = readMetaContent('meta[property="og:image"]');
          if (ogImage) {
            return ogImage;
          }

          const twitterImage = readMetaContent('meta[name="twitter:image"]');
          if (twitterImage) {
            return twitterImage;
          }

          const postImg = document.querySelector('.post-body img, .entry-content img, article img, #main img');
          const imageSrc = postImg?.getAttribute('src') || postImg?.src || null;
          return imageSrc?.trim() || null;
        }));

        // Get clean text content of the page for Gemini's recipe parsing
        const rawText = await page.evaluate(() => document.body.innerText);

        if (!rawText || rawText.length < 200) {
          throw new Error(`Content too short (${rawText?.length || 0} chars). Cloudflare/Bot blocked?`);
        }

        // 3. Extract structured recipe with Gemini
        const cleanRecipe = await extractRecipe(rawText);

        if (cleanRecipe) {
          // Generate a clean slug for MongoDB's unique index
          const slug = generateSlug(sanitizedUrl, cleanRecipe.title);
          const sourceImageUrl = hasValidImageUrl(cleanRecipe.imageUrl)
            ? normalizeImageUrl(cleanRecipe.imageUrl)
            : domImageUrl;

          let cloudinaryImages = [];
          if (sourceImageUrl) {
            try {
              const uploadedImage = await uploadRecipeImage(sourceImageUrl, `${slug}-${task._id}-0`);
              cloudinaryImages = toImageArray(uploadedImage);
            } catch (imgErr) {
              console.log(`  ⚠ Image upload failed: ${imgErr.message}`);
            }
          }

          // 4. Update or insert the recipe into the final collection
          await recipes.updateOne(
            { url: sanitizedUrl },
            { 
              $set: { 
                ...cleanRecipe, 
                images: cloudinaryImages,
                imageUrl: cloudinaryImages,
                url: sanitizedUrl, // Save clean URL without hashes
                sourceUrl: sanitizedUrl,
                slug: slug, 
                updatedAt: new Date(), 
                source: 'christinesrecipes',
                sourceSite: 'christinesrecipes',
                scrapedAt: new Date(),
              } 
            },
            { upsert: true }
          );
          
          // 5. Mark the task completed
          await queues.updateOne({ _id: task._id }, { $set: { status: 'completed' } });
          console.log(`  ✅ Success: "${cleanRecipe.title}" added to DB with slug: "${slug}"`);
        } else {
          // If Gemini successfully parsed but marked as no recipe found, set status to 'skipped'
          await queues.updateOne(
            { _id: task._id }, 
            { $set: { status: 'skipped', lastError: 'No clear recipe elements found on page.', processedAt: new Date() } }
          );
          console.log(`  ⚠️ Skipped: No recipe found on page. Marked as 'skipped'.`);
        }
      } catch (err) {
        console.error(`  ❌ Failed: ${task.url} - ${err.message}`);
        
        // Set status to 'error' (instead of 'failed') to avoid retrying it immediately in this run
        await queues.updateOne(
          { _id: task._id }, 
          { $set: { status: 'error', lastError: err.message, failedAt: new Date() } }
        );
      }

      processedCount += 1;

      // 6. Polite sleep (3.5s) to avoid triggering aggressive IP limits or Gemini 429 warnings
      if (processedCount < MAX_TASKS_PER_RUN) {
        await new Promise(r => setTimeout(r, 3500));
      }
    }

    if (processedCount >= MAX_TASKS_PER_RUN) {
      console.log(`\nReached Christine batch limit of ${MAX_TASKS_PER_RUN}. Stopping script...`);
    }

    await browser.close();
  } catch (globalErr) {
    console.error("🚨 Fatal Worker Error:", globalErr.message);
  } finally {
    await client.close();
    console.log("🏁 Database connection closed. Terminal session finished.");
    process.exit(0);
  }
}

runChristineWorker();
