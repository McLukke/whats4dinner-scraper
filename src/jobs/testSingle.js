import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { extractRecipe } from '../lib/gemini.js';
import { uploadRecipeImage } from '../lib/cloudinary.js';
import { Recipe } from '../models/Recipe.js';

const RAW_TEXT = `
Beef and Broccoli: Authentic Restaurant Recipe
Author: Bill Leung
Serves: 6 | Prep: 35 minutes | Cook: 15 minutes | Total: 50 minutes

"Beef and Broccoli is one of the most popular dishes on Chinese restaurant menus" and this recipe reveals how restaurants achieve tender beef by tenderizing with baking soda, cooking components separately, then combining with thickened sauce for authentic takeout-style results.

For the beef and marinade:
1 pound flank steak (sliced 1/4-inch or 0.6cm thick)
1/4 teaspoon baking soda (optional)
3 tablespoons water
1 1/2 teaspoons cornstarch
2 teaspoons vegetable oil
1 teaspoon oyster sauce

For the sauce:
2/3 cup low sodium chicken stock (warmed)
1 1/2 teaspoons granulated sugar (or brown sugar)
1 1/2 tablespoons soy sauce
1 teaspoon dark soy sauce
1 tablespoon oyster sauce
1/2 teaspoon sesame oil
1/8 teaspoon white pepper

For the rest of the dish:
4 cups broccoli florets
3 tablespoons vegetable oil (divided)
2 cloves garlic (minced)
1/4 teaspoon ginger (grated/minced, optional)
1 tablespoon Shaoxing wine
2 1/2 tablespoons cornstarch (mixed with 3 tablespoons/45ml water)

Instructions:
1. In a bowl, add sliced beef with baking soda and water. Massage beef until liquid absorbs. Mix in cornstarch, oil, and oyster sauce. Marinate at least 30 minutes.
2. Prepare sauce by combining chicken stock, sugar, soy sauce, dark soy sauce, oyster sauce, sesame oil, and white pepper. Set aside.
3. Boil water and blanch broccoli for 30-60 seconds. Drain and set aside.
4. Heat wok over high heat until smoking. Add 2 tablespoons oil and sear beef on both sides until browned (2-3 minutes). Remove and set aside.
5. Set wok to medium heat, add 1 tablespoon oil with garlic and ginger. Stir 5 seconds, then pour Shaoxing wine around wok perimeter.
6. Add prepared sauce mixture. Stir to deglaze wok. Bring to simmer. Mix cornstarch slurry and drizzle into sauce while stirring constantly. Simmer 20 seconds to thicken.
7. Add blanched broccoli and seared beef with juices. Mix over medium heat until sauce coats ingredients. Serve with steamed rice.

Tags: Chinese, beef, broccoli, stir-fry, takeout, weeknight, Asian
Image URL: https://thewoksoflife.com/wp-content/uploads/2019/04/beef-and-broccoli-8.jpg
Source URL: https://thewoksoflife.com/beef-with-broccoli-all-purpose-stir-fry-sauce/
`;

function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function run() {
  console.log('--- Step 1: Extracting via Gemini ---');
  const extracted = await extractRecipe(RAW_TEXT);
  console.log('\nExtracted JSON:\n', JSON.stringify(extracted, null, 2));

  const slug = toSlug(extracted.title);

  console.log('\n--- Step 2: Uploading image to Cloudinary ---');
  const imageUrl = await uploadRecipeImage(extracted.imageUrl, slug);
  console.log('Cloudinary URL:', imageUrl ?? '(no image found)');

  console.log('\n--- Step 3: Connecting to MongoDB ---');
  await connectMongo();
  console.log('Connected.');

  const doc = await Recipe.findOneAndUpdate(
    { slug },
    {
      ...extracted,
      slug,
      imageUrl,
      sourceUrl: 'https://thewoksoflife.com/beef-with-broccoli-all-purpose-stir-fry-sauce/',
      sourceSite: 'thewoksoflife',
      scrapedAt: new Date(),
    },
    { upsert: true, returnDocument: 'after', runValidators: true }
  );

  console.log('\n--- Step 4: Saved to MongoDB ---');
  console.log('_id     :', doc._id.toString());
  console.log('slug    :', doc.slug);
  console.log('title   :', doc.title);
  console.log('imageUrl:', doc.imageUrl ?? '(none)');
  console.log('chinese :', doc.chineseName ?? '(not found in page text)');
  console.log('groups  :', [...new Set(doc.ingredients.map(i => i.group))].join(', '));

  await disconnectMongo();
  console.log('\nDone.');
}

run().catch(err => {
  console.error('\nPipeline error:', err.message);
  if (err.message?.includes('ECONNREFUSED') || err.message?.includes('querySrv')) {
    console.error('\nMongoDB connection failed. Check:');
    console.error('  1. MONGODB_URI in .env is correct');
    console.error('  2. Your IP is whitelisted in Atlas → Network Access → Add IP Address');
    console.error('  3. Atlas cluster is not paused');
  }
  process.exit(1);
});
