import { v2 as cloudinary } from 'cloudinary';
import axios from 'axios';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 4:3 uniform thumbnail for gallery display
const UPLOAD_OPTIONS = {
  folder: 'whats4dinner/recipes',
  transformation: [
    { width: 400, height: 300, crop: 'fill', gravity: 'center', fetch_format: 'webp', quality: 'auto' },
  ],
};

function streamUpload(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// Upload a pre-downloaded buffer — bypasses CDN hotlink protection
export async function uploadRecipeImageBuffer(buffer, publicId) {
  if (!buffer) return null;
  const result = await streamUpload(buffer, { ...UPLOAD_OPTIONS, public_id: publicId });
  return result.secure_url;
}

// Download via axios then upload — for public URLs (YouTube thumbnails, etc.)
export async function uploadRecipeImage(imageUrl, publicId) {
  if (!imageUrl) return null;
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': new URL(imageUrl).origin + '/',
    },
  });
  return uploadRecipeImageBuffer(Buffer.from(response.data), publicId);
}
