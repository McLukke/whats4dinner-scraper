import 'dotenv/config';
import { v2 as cloudinary } from 'cloudinary';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { Recipe } from '../models/Recipe.js';
import { Queue } from '../models/Queue.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function purgeCloudinaryFolder(prefix) {
  let deleted = 0;
  let nextCursor;
  do {
    const res = await cloudinary.api.delete_resources_by_prefix(prefix, {
      resource_type: 'image',
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });
    deleted += Object.keys(res.deleted ?? {}).length;
    nextCursor = res.next_cursor;
  } while (nextCursor);
  return deleted;
}

async function purge() {
  console.log('=== Purge starting ===\n');

  await connectMongo();

  const { deletedCount: recipes } = await Recipe.deleteMany({});
  console.log(`MongoDB recipes:    deleted ${recipes}`);

  const { deletedCount: queued } = await Queue.deleteMany({});
  console.log(`MongoDB queue:      deleted ${queued}`);

  await disconnectMongo();

  console.log('\nPurging Cloudinary folder whats4dinner/recipes ...');
  const cloudDeleted = await purgeCloudinaryFolder('whats4dinner/recipes');
  console.log(`Cloudinary assets:  deleted ${cloudDeleted}`);

  console.log('\n=== Purge complete ===');
}

purge().catch(err => {
  console.error('Purge failed:', err.message);
  process.exit(1);
});
