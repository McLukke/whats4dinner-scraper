import mongoose from 'mongoose';

const QueueSchema = new mongoose.Schema({
  url:         { type: String, required: true, unique: true },
  site:        { type: String, required: true },
  status:      { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  priority:    { type: Number, default: 0 },    // higher = processed first; prioritySeed.js uses 10
  lastmod:     { type: Date, default: null },   // populated from sitemap <lastmod> where available
  lastError:   { type: String, default: null },
  processedAt: { type: Date, default: null },
  reprocess:   { type: Boolean, default: false }, // set by purgeFluff.js for re-extraction passes
}, { timestamps: true });

// Priority first, then newest lastmod, then FIFO within the same tier
QueueSchema.index({ status: 1, priority: -1, lastmod: -1, createdAt: 1 });

export const Queue = mongoose.model('Queue', QueueSchema);
