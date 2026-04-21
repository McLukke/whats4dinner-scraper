import mongoose from 'mongoose';

const QueueSchema = new mongoose.Schema({
  url:         { type: String, required: true, unique: true },
  site:        { type: String, required: true },
  status:      { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  lastError:   { type: String, default: null },
  processedAt: { type: Date, default: null },
}, { timestamps: true });

QueueSchema.index({ status: 1, createdAt: 1 });

export const Queue = mongoose.model('Queue', QueueSchema);
