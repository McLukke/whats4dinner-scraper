import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const EXTRACTION_PROMPT = `
You are an expert recipe extraction assistant specialising in Asian cuisine — Chinese, Japanese, Korean, and Southeast Asian cooking.
Given raw text scraped from a recipe webpage, extract structured data.
Return ONLY valid JSON — no markdown fences, no commentary — matching this schema exactly.
If the page contains no clear recipe, return exactly: {"error": "no_recipe_found"}

{
  "title": "string",
  "asianName": "string | null",
  "description": "string",
  "servings": number | null,
  "prepTimeMinutes": number | null,
  "cookTimeMinutes": number | null,
  "totalTimeMinutes": number | null,
  "fermentationTimeMinutes": number | null,
  "marinationTimeMinutes": number | null,
  "category": "Baking" | "Cooking",
  "ingredients": [
    {
      "group": "string",
      "quantity": number | null,
      "unit": "string (always full English words: 'tablespoon', 'teaspoon', 'cup', 'gram', 'millilitre' — never abbreviations)",
      "name": "string",
      "notes": "string | null"
    }
  ],
  "instructions": ["string"],
  "tags": ["string"],
  "cuisine": "string | null",
  "difficulty": "easy" | "medium" | "hard" | null,
  "imageUrl": "string | null"
}

## Content filter — return {"error": "no_recipe_found"} if:
- The page is primarily about gardening, plant care, history, travel, or author biography.
- There is no ingredient list and no cooking instructions.
- The content is a teaser, preview, or "pre-prep" story with no actionable recipe.

## Negative constraints — STRICT purity rules
Ingredients:
- Extract ONLY items physically added to the dish during preparation.
- EXCLUDE: "Suggested pairings", "Serving suggestions", "Goes well with", "Garden preparation tips", "Historical context", "Where to buy" recommendations.
- Each ingredient entry must be a discrete item with a quantity/unit. Narrative sentences like "You can also add X if you like" must be dropped.

Instructions:
- Each step must be a pure action sentence: verb + object + method (e.g. "Heat oil in pan over medium heat until shimmering").
- STRIP all narrative from steps. Remove sentences containing: personal anecdote ("My grandmother…", "I remember…", "We always…"), place references ("In Hong Kong…", "During my trip…"), historical notes, emotional language, or blog commentary.
- If a step mixes action with narrative, keep only the actionable clause.

Keyword contamination:
- Before finalising, scan your extracted instructions and ingredient notes for these words: garden, soil, seeds, fertilizer, childhood, memory, trip, travel, grandmother, nostalgia.
- If these words appear in more than 10% of your extracted tokens, the page is contaminated with lifestyle content — return {"error": "no_recipe_found"} instead.

## Category rules
- Set category to "Baking" if the ingredients or instructions are dominated by: oven, flour, yeast, cake, bread, bake, pastry, dough, muffin, cookie, tart, or pie.
- Otherwise set category to "Cooking".

## Timing rules
- servings: integer number of servings; null if not stated.
- prepTimeMinutes: active hands-on preparation time only; integer.
- cookTimeMinutes: active cooking time only; integer.
- totalTimeMinutes: total end-to-end time from start to table; integer. If not explicitly stated, compute as prepTimeMinutes + cookTimeMinutes (ignoring passive times).
- fermentationTimeMinutes: any passive fermentation time mentioned (e.g. kimchi fermenting 1–2 days = 1440–2880 min). If a range is given, use the midpoint.
- marinationTimeMinutes: any passive marinating/resting time (e.g. "marinate overnight" = 480 min, "marinate 30 min" = 30). If a range is given, use the minimum.

## Ingredient grouping rules
- Use section headings from the recipe as group names. Preserve them exactly (e.g. "Vegetables", "Meat", "Sauce", "Marinade", "Batter", "Seasoning").
- For Korean recipes, typical groups include: 'Meat', 'Marinade', 'Vegetables', 'Sauce', 'Batter', 'Garnish', 'Seasoning', 'Kimchi Base', 'Paste'.
- For Japanese recipes, typical groups include: 'Main', 'Sauce', 'Tare', 'Broth', 'Toppings', 'Filling'.
- For complex dishes (bibimbap, ramen, hot pot), every component MUST have its own group.

## Asian culinary ingredient rules
Chinese:
  • Soy sauce: note type (regular, light/生抽, dark/老抽, tamari)
  • Doubanjiang / toban djan: note spicy vs non-spicy
Japanese:
  • Miso: note TYPE in notes field (white/shiro, red/aka, mixed/awase, Saikyo, Hatcho)
  • Dashi: note TYPE (kombu, katsuobushi/bonito, niboshi, shiitake, awase)
  • Sake vs mirin: always distinct — never merge them
Korean — preserve these terms exactly in the name field, do not translate:
  • Gochugaru (고추가루) — Korean red pepper flakes; note coarse vs fine grind if mentioned
  • Gochujang (고추장) — fermented red pepper paste
  • Doenjang (된장) — fermented soybean paste; note aged vs regular if mentioned
  • Ganjang (간장) — Korean soy sauce; note soup soy sauce (국간장) vs regular
  • Maesil-cheong — Korean plum extract/syrup
  • Saeujeot (새우젓) — salted fermented shrimp
  • Myeolchi-aekjeot — Korean fish sauce (anchovy)
  • Perilla vs sesame leaves: treat as distinct — never merge
  • Korean radish (mu/무) vs daikon: treat as distinct

## General rules
- asianName: extract native-script name (Korean 한글, Chinese 漢字, Japanese かな/漢字) or romanised name if present; otherwise null.
- quantity: always a number. Convert fractions: 1/4 → 0.25, 2/3 → 0.667, 1½ → 1.5.
- unit: full words only. tbsp → tablespoon, tsp → teaspoon, oz → ounce, lb → pound, g → gram, ml → millilitre.
- difficulty: infer from total active time and technique complexity.

Raw text:
`;

// Strip <think> blocks, then extract JSON from any ```json ... ``` fence
// or parse bare JSON — handles all Gemini 2.5 Flash response styles.
function parseGeminiJson(raw) {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenceMatch = noThink.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : noThink;
  return JSON.parse(candidate);
}

const FLUFF_KEYWORDS = ['garden', 'soil', 'seeds', 'fertilizer', 'childhood', 'memory', 'trip', 'travel', 'grandmother', 'nostalgia'];

const RECIPE_ONLY_PREFIX = `RECIPE-ONLY MODE: The following text may contain lifestyle or blog content mixed with a recipe. Extract ONLY the cooking ingredients and instructions. Ignore all personal stories, travel anecdotes, garden notes, and historical context. If you cannot isolate a clear recipe, return {"error": "no_recipe_found"}.\n\n`;

function fluffDensity(text) {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length === 0) return 0;
  const fluffCount = words.filter(w => FLUFF_KEYWORDS.some(k => w.includes(k))).length;
  return fluffCount / words.length;
}

export async function extractRecipe(rawText) {
  // Cap at 16 000 chars — enough for complex multi-component recipes (bibimbap, ramen)
  const text = rawText.slice(0, 16_000);

  const density = fluffDensity(text);

  
  const prompt = density > 0.10
    ? EXTRACTION_PROMPT + RECIPE_ONLY_PREFIX + text
    : EXTRACTION_PROMPT + text;

  const result = await model.generateContent({
    contents: prompt,
    generationConfig: {
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });
  const raw = result.response.text().trim();
  try {
    const parsed = parseGeminiJson(raw);
    // Treat explicit error sentinel the same as null (caller checks for falsy)
    if (parsed?.error) return null;
    return parsed;
  } catch {
    // Surface the raw response so we can diagnose prompt failures
    throw new Error(`Gemini JSON parse failed. Raw response:\n${raw.slice(0, 500)}`);
  }
}
