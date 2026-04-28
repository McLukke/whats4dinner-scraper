import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

const JUNK_IMAGE_PATTERN = /(logo|avatar|placeholder|spinner|blank|1x1|pixel|gravatar)/i;

function hasJunkImages(doc) {
  if (!doc.images || doc.images.length === 0) return true;
  return doc.images.every(url => JUNK_IMAGE_PATTERN.test(url));
}

async function run() {
  await connectMongo();

  const recipes = await Recipe.find(
    {},
    { _id: 1, slug: 1, sourceUrl: 1, sourceSite: 1, images: 1 }
  ).lean();

  const targets = recipes.filter(hasJunkImages);

  if (targets.length === 0) {
    console.log('No recipes with missing or junk images found.');
    await disconnectMongo();
    return;
  }

  console.log(`Found ${targets.length} recipe(s) with missing or junk images out of ${recipes.length} total.\n`);

  let requeued = 0;
  let skipped = 0;

  for (const recipe of targets) {
    const reason = (!recipe.images || recipe.images.length === 0) ? 'no images' : 'all junk';
    console.log(`  [${reason}] ${recipe.slug}`);
    console.log(`    ${recipe.sourceUrl}`);

    if (!recipe.sourceUrl || !recipe.sourceSite) {
      console.log(`    ↳ skipped — missing sourceUrl/sourceSite`);
      skipped++;
      continue;
    }

    await Queue.findOneAndUpdate(
      { url: recipe.sourceUrl },
      {
        $set: {
          status: 'pending',
          imageOnly: true,
          lastError: null,
          processedAt: null,
        },
        $setOnInsert: {
          site: recipe.sourceSite,
          priority: 5,
        },
      },
      { upsert: true }
    );
    requeued++;
  }

  console.log(`\nDone. Re-queued: ${requeued}  Skipped: ${skipped}`);
  await disconnectMongo();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
