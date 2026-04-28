import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Queue } from '../models/Queue.js';

const TARGETS = [
  { url: 'https://www.christinesrecipes.com/search/label/Meat',                site: 'christinesrecipes' },
  { url: 'https://www.christinesrecipes.com/search/label/Vegetables',          site: 'christinesrecipes' },
  { url: 'https://www.daydaycook.com/daydaycook/hk/en/recipe/index.do',        site: 'daydaycook' },
  { url: 'https://www.hk01.com/tag/7161',                                      site: 'hk01' },
  { url: 'https://hk.news.yahoo.com/food',                                     site: 'yahoohk' },
];

async function seed() {
  await connectMongo();

  const ops = TARGETS.map(({ url, site }) => ({
    updateOne: {
      filter: { url },
      update: { $set: { url, site, status: 'pending', priority: 10, lastError: null } },
      upsert: true,
    },
  }));

  const result = await Queue.bulkWrite(ops);
  console.log(`Priority seed: ${result.upsertedCount} inserted, ${result.modifiedCount} updated.`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

seed().catch(err => {
  console.error('Priority seed failed:', err.message);
  process.exit(1);
});
