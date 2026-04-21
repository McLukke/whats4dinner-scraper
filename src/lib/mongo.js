import mongoose from 'mongoose';

let connected = false;

export async function connectMongo() {
  if (connected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  connected = true;
}

export async function disconnectMongo() {
  await mongoose.disconnect();
  connected = false;
}
