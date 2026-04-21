import mongoose from 'mongoose';

const IngredientSchema = new mongoose.Schema({
  group: String,
  quantity: Number,
  unit: String,
  name: { type: String, required: true },
  notes: String,
}, { _id: false });

const RecipeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  asianName: String,
  slug: { type: String, required: true, unique: true },
  description: String,
  sourceUrl: { type: String, required: true },
  sourceSite: String,
  images: { type: [String], default: [] },
  videoUrl: String,
  prepTimeMinutes: Number,
  cookTimeMinutes: Number,
  fermentationTimeMinutes: Number,
  marinationTimeMinutes: Number,
  servings: Number,
  ingredients: [IngredientSchema],
  instructions: [String],
  tags: [String],
  cuisine: String,
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
  scrapedAt: { type: Date, default: Date.now },
}, { timestamps: true });

RecipeSchema.index({ tags: 1 });
RecipeSchema.index({ cuisine: 1 });
RecipeSchema.index({ scrapedAt: -1 });

export const Recipe = mongoose.model('Recipe', RecipeSchema);
