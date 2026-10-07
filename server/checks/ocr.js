// Nameplate / signage OCR. Provider is pluggable; 'none' skips the check (scored as NAME_NOT_CHECKED).
import { config } from '../config.js';

export async function extractText(jpegBuffer) {
  switch (config.ocrProvider) {
    case 'none':
      return null;
    case 'google-vision':
      return googleVision(jpegBuffer);
    default:
      throw new Error(`Unknown OCR_PROVIDER "${config.ocrProvider}"`);
  }
}

async function googleVision(buffer) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(config.googleVisionApiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: buffer.toString('base64') },
          features: [{ type: 'TEXT_DETECTION' }],
          imageContext: { languageHints: ['en', 'hi', 'mr', 'ta', 'te'] },
        }],
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`Vision API ${res.status}`);
  const json = await res.json();
  return json.responses?.[0]?.fullTextAnnotation?.text ?? '';
}

const normalise = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

// Fraction of meaningful name tokens (len >= 3) that appear in the OCR text, allowing 1 typo per token.
export function nameMatchScore(expectedName, ocrText) {
  if (!expectedName || !ocrText) return 0;
  const want = normalise(expectedName).filter((t) => t.length >= 3);
  const have = normalise(ocrText);
  if (!want.length) return 0;
  const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 5 && levenshtein(w, h) <= 1)));
  return hits.length / want.length;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
