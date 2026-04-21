import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const EXTRACTION_PROMPT = `
You are an expert recipe extraction assistant specialising in Asian cuisine — Chinese, Japanese, Korean, and Southeast Asian cooking.
Given raw text scraped from a recipe webpage, extract structured data.
Return ONLY valid JSON — no markdown fences, no commentary — matching this schema exactly:

{
  "title": "string",
  "asianName": "string | null",
  "description": "string",
  "prepTimeMinutes": number | null,
  "cookTimeMinutes": number | null,
  "fermentationTimeMinutes": number | null,
  "marinationTimeMinutes": number | null,
  "servings": number | null,
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

## Timing rules
- prepTimeMinutes: active hands-on preparation time only.
- cookTimeMinutes: active cooking time only.
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

export async function extractRecipe(rawText) {
  // Cap at 16 000 chars — enough for complex multi-component recipes (bibimbap, ramen)
  const text = rawText.slice(0, 16_000);
  const result = await model.generateContent(EXTRACTION_PROMPT + text);
  const raw = result.response.text().trim();
  try {
    return parseGeminiJson(raw);
  } catch {
    // Surface the raw response so we can diagnose prompt failures
    throw new Error(`Gemini JSON parse failed. Raw response:\n${raw.slice(0, 500)}`);
  }
}
