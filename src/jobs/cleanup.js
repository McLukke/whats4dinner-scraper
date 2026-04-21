/**
 * One-time queue cleanup — removes known non-recipe URLs that leaked through
 * the seeder's negative filter. Safe to re-run; deletes only junk patterns.
 */
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Queue } from '../models/Queue.js';

// URL substrings that are definitively not recipe pages
const JUNK_PATTERNS = [
  '/visual-recipe-index/',
  '/filter/',
  '/wok-guide/',
  '/glossary/',
  '/guide/',
  '/cookbook/',
  '/recipe-index/',
  '/all-recipes/',
  '/blog/',
  '/about/',
  '/contact/',
  '/resources/',
  '/ingredients/',
  '/kitchenware/',
  '/utensils/',
  '/tools/',
  '/equipment/',
  '/pantry/',
  '/recipes/',      // category index pages (e.g. maangchi.com/recipes/)
  '/vietnamese/',   // hungryhuy category page itself
];

async function cleanup() {
  await connectMongo();

  const regex = new RegExp(JUNK_PATTERNS.map(p => p.replace(/\//g, '\\/')).join('|'));
  const result = await Queue.deleteMany({ url: { $regex: regex } });

  console.log(`Removed ${result.deletedCount} junk queue entries.`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

cleanup().catch(err => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
