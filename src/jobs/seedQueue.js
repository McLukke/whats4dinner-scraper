import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Queue } from '../models/Queue.js';

const URLS = [
  // Just One Cookbook — Japanese
  { url: 'https://www.justonecookbook.com/chicken-teriyaki/',           site: 'justonecookbook' },
  { url: 'https://www.justonecookbook.com/homemade-chashu-miso-ramen/', site: 'justonecookbook' },
  { url: 'https://www.justonecookbook.com/onigiri-rice-balls/',         site: 'justonecookbook' },
  // Maangchi — Korean
  { url: 'https://www.maangchi.com/recipe/dakgangjeong',               site: 'maangchi' },
  { url: 'https://www.maangchi.com/recipe/bibimbap',                   site: 'maangchi' },
  { url: 'https://www.maangchi.com/recipe/kimchi-jjigae',              site: 'maangchi' },
  { url: 'https://www.maangchi.com/recipe/japchae',                    site: 'maangchi' },
  { url: 'https://www.maangchi.com/recipe/bulgogi',                    site: 'maangchi' },
  // Southeast Asian
  { url: 'https://hot-thai-kitchen.com/pad-thai/',                     site: 'hotthaikitchen' },
  { url: 'https://www.woksoflife.com/pho-recipe/',                     site: 'woksoflife' },
];

async function seed() {
  await connectMongo();

  const ops = URLS.map(({ url, site }) => ({
    updateOne: {
      filter: { url },
      update: { $setOnInsert: { url, site, status: 'pending', lastError: null } },
      upsert: true,
    },
  }));

  const result = await Queue.bulkWrite(ops);
  console.log(`Seeded: ${result.upsertedCount} inserted, ${result.matchedCount} already existed.`);

  const counts = await Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  console.log('Queue status:', Object.fromEntries(counts.map(c => [c._id, c.count])));

  await disconnectMongo();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
