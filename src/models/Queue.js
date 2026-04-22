import mongoose from 'mongoose';

const QueueSchema = new mongoose.Schema({
  url:         { type: String, required: true, unique: true },
  site:        { type: String, required: true },
  status:      { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  lastmod:     { type: Date, default: null },   // populated from sitemap <lastmod> where available
  lastError:   { type: String, default: null },
  processedAt: { type: Date, default: null },
}, { timestamps: true });

// Newest lastmod first (nulls sort last), then FIFO within the same lastmod tier
QueueSchema.index({ status: 1, lastmod: -1, createdAt: 1 });

export const Queue = mongoose.model('Queue', QueueSchema);
