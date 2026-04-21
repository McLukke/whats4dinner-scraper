import { chromium } from 'playwright';

export async function scrapePageText(url) {
  const browser = await chromium.launchPersistentContext(
    process.env.USER_DATA_DIR ?? './playwright-profile',
    { headless: true }
  );
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_500); // let JS hydrate
    const text = await page.evaluate(() => document.body.innerText);
    const imageUrl = await page
      .evaluate(() => {
        const og = document.querySelector('meta[property="og:image"]');
        return og?.content ?? null;
      });
    return { text, imageUrl };
  } finally {
    await browser.close();
  }
}
