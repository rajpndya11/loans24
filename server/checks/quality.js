import sharp from 'sharp';

const ANALYSIS_WIDTH = 640;

// Decodes the upload (rejecting anything that is not a real image), strips metadata,
// and returns a normalised JPEG plus quality metrics and a perceptual hash.
export async function analysePhoto(buffer) {
  const base = sharp(buffer, { failOn: 'error', limitInputPixels: 50_000_000 }).rotate();
  const meta = await base.metadata();

  // Re-encode: strips EXIF/GPS from the stored file (we record server-side location instead).
  const normalised = await base.clone()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  const { data, info } = await sharp(normalised)
    .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    normalised,
    width: meta.width,
    height: meta.height,
    sharpness: laplacianVariance(data, info.width, info.height),
    brightness: meanLuma(data),
    phash: await dHash(normalised),
  };
}

export function laplacianVariance(px, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = px[i - w] + px[i + w] + px[i - 1] + px[i + 1] - 4 * px[i];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.round((sumSq / n - mean * mean) * 10) / 10;
}

function meanLuma(px) {
  let s = 0;
  for (let i = 0; i < px.length; i++) s += px[i];
  return Math.round(s / px.length);
}

// 64-bit difference hash as 16 hex chars; robust to re-compression and resizing.
async function dHash(buffer) {
  const { data } = await sharp(buffer).grayscale().resize(9, 8, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export function hammingHex(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

export function judgeQuality({ sharpness, brightness }, q) {
  const checks = {
    sharpness: { value: sharpness, pass: sharpness >= q.minSharpness },
    lighting: { value: brightness, pass: brightness >= q.minBrightness && brightness <= q.maxBrightness },
  };
  const hint = !checks.lighting.pass
    ? (brightness < q.minBrightness ? 'TOO_DARK' : 'TOO_BRIGHT')
    : !checks.sharpness.pass ? 'BLURRY' : null;
  return { ok: checks.sharpness.pass && checks.lighting.pass, checks, hint };
}
