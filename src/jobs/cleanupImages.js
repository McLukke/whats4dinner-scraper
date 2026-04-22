/**
 * Maintenance script — three jobs in one pass:
 *   1. Logs the mainImage URL of the last 20 recipes so you can identify bad patterns.
 *   2. Finds recipes whose mainImage matches known placeholder patterns and re-queues them.
 *   3. Deletes ALL recipes created in the last 24 hours and resets their queue to 'pending',
 *      so the improved scraper (metadata-first + scroll loop) can re-process them cleanly.
 */
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

const PLACEHOLDER_PATTERNS = [
  'blank.gif',
  'placeholder',
  'site-logo',
  'no-image',
  'default-image',
  'noimage',
  'loading.gif',
  'transparent.png',
  'akamaihd.net/placeholder',
  'data:image',   // inline data URIs
  'base64',       // any base64-encoded image stored as a URL
];

async function cleanupImages() {
  await connectMongo();

  // ── 1. DIAGNOSTIC: show what the last 20 mainImages actually look like ──────
  console.log('=== DIAGNOSTIC: mainImage URLs of the last 20 scraped recipes ===');
  const recent = await Recipe.find({}).sort({ createdAt: -1 }).limit(20).lean();
  for (const r of recent) {
    const main = r.images?.[0] ?? '(none)';
    console.log(`  ${r.title}`);
    console.log(`    mainImage : ${main}`);
    console.log(`    createdAt : ${r.createdAt?.toISOString()}`);
  }
  console.log('');

  // ── 2. PLACEHOLDER DETECTION ─────────────────────────────────────────────────
  console.log('=== BAD IMAGE DETECTION (placeholder patterns) ===');
  const placeholderRegex = new RegExp(PLACEHOLDER_PATTERNS.join('|'), 'i');

  const placeholderBad = await Recipe.find({
    $or: [
      { images: { $size: 0 } },
      { 'images.0': { $regex: placeholderRegex } },
    ],
  }).lean();

  if (placeholderBad.length === 0) {
    console.log('  None found.\n');
  } else {
    console.log(`  Found ${placeholderBad.length} recipe(s):`);
    for (const r of placeholderBad) {
      const label = r.images.length === 0 ? 'no images' : 'placeholder';
      console.log(`  [${label}] ${r.title}`);
      console.log(`    mainImage : ${r.images?.[0] ?? '(none)'}`);
      console.log(`    source    : ${r.sourceUrl}`);
    }
    console.log('');
  }

  // ── 3. LAST-24H RE-QUEUE ──────────────────────────────────────────────────────
  console.log('=== LAST-24H RE-QUEUE ===');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`  Targeting recipes created after: ${since.toISOString()}`);

  const recentBad = await Recipe.find({ createdAt: { $gte: since } }).lean();
  console.log(`  Found ${recentBad.length} recipe(s) from the last 24 hours.\n`);

  // ── 4. UNION + EXECUTE ────────────────────────────────────────────────────────
  const allIds = new Set([
    ...placeholderBad.map(r => r._id.toString()),
    ...recentBad.map(r => r._id.toString()),
  ]);
  const allSourceUrls = new Set([
    ...placeholderBad.map(r => r.sourceUrl),
    ...recentBad.map(r => r.sourceUrl),
  ]);

  if (allIds.size === 0) {
    console.log('Nothing to clean up.');
    await disconnectMongo();
    return;
  }

  const queueResult = await Queue.updateMany(
    { url: { $in: [...allSourceUrls] } },
    { $set: { status: 'pending', lastError: null, processedAt: null } }
  );

  const deleteResult = await Recipe.deleteMany({
    _id: { $in: [...allIds] },
  });

  console.log(`Deleted   : ${deleteResult.deletedCount} recipe(s)`);
  console.log(`Re-queued : ${queueResult.modifiedCount} queue entry/entries → 'pending'`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

cleanupImages().catch(err => {
  console.error('cleanupImages failed:', err.message);
  process.exit(1);
});
