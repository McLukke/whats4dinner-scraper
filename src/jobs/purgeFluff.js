import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

// A single instruction step this long is almost certainly narrative, not a cooking action.
const MAX_STEP_CHARS = 500;

// Total instructions text over this limit suggests embedded blog content.
const MAX_TOTAL_INSTRUCTIONS_CHARS = 2000;

// Total serialised ingredients over this limit suggests narrative notes crept in.
const MAX_TOTAL_INGREDIENTS_CHARS = 2000;

function isFluffyRecipe(doc) {
  const totalInstructions = (doc.instructions ?? []).join('\n');
  if (totalInstructions.length > MAX_TOTAL_INSTRUCTIONS_CHARS) return true;
  if ((doc.instructions ?? []).some(step => step.length > MAX_STEP_CHARS)) return true;
  if (JSON.stringify(doc.ingredients ?? []).length > MAX_TOTAL_INGREDIENTS_CHARS) return true;
  return false;
}

async function run() {
  await connectMongo();

  // Fetch all recipes — field-project to avoid pulling images/large blobs
  const recipes = await Recipe.find(
    {},
    { _id: 1, title: 1, sourceUrl: 1, sourceSite: 1, instructions: 1, ingredients: 1 }
  ).lean();

  const fluffyRecipes = recipes.filter(isFluffyRecipe);

  if (fluffyRecipes.length === 0) {
    console.log('No fluff-flagged recipes found.');
    await disconnectMongo();
    return;
  }

  console.log(`Found ${fluffyRecipes.length} fluff-flagged recipe(s) out of ${recipes.length} total.\n`);

  let requeued = 0;
  let skipped = 0;

  for (const recipe of fluffyRecipes) {
    const diagnostics = [];
    const totalInstructions = (recipe.instructions ?? []).join('\n');
    if (totalInstructions.length > MAX_TOTAL_INSTRUCTIONS_CHARS) {
      diagnostics.push(`instructions ${totalInstructions.length} chars`);
    }
    const longStep = (recipe.instructions ?? []).find(s => s.length > MAX_STEP_CHARS);
    if (longStep) diagnostics.push(`step too long (${longStep.length} chars)`);
    const ingLen = JSON.stringify(recipe.ingredients ?? []).length;
    if (ingLen > MAX_TOTAL_INGREDIENTS_CHARS) diagnostics.push(`ingredients ${ingLen} chars`);

    console.log(`  [${diagnostics.join(', ')}] ${recipe.title}`);
    console.log(`    ${recipe.sourceUrl}`);

    if (!recipe.sourceUrl || !recipe.sourceSite) {
      console.log(`    ↳ skipped — missing sourceUrl/sourceSite`);
      skipped++;
      continue;
    }

    // Upsert back into the queue as pending with the reprocess flag.
    // The unique index on `url` means this is safe to run multiple times.
    await Queue.findOneAndUpdate(
      { url: recipe.sourceUrl },
      {
        $set: {
          status: 'pending',
          reprocess: true,
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
