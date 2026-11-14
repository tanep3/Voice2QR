// Shared helpers for the library tests: the deterministic synthetic
// signal (ported 1:1 from core/testutil/shared.rs) and QR rendering.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fixtureHex(rel) {
  return Buffer.from(readFileSync(join(repo, rel), 'utf8').trim(), 'hex');
}

export function syntheticPcm() {
  const pcm = new Int16Array(8000);
  let rng = 0x12345678;
  let phase = 0;
  for (let n = 0; n < 8000; n++) {
    const period = 80 - Math.floor((27 * n) / 8000);
    phase = (phase + Math.floor(0x10000 / period)) >>> 0;
    let v = 0;
    for (let k = 1; k <= 6; k++) {
      const p = Math.imul(phase, k) & 0xffff;
      const tri = p < 0x8000 ? p * 2 - 0x8000 : 0x18000 - p * 2;
      v += Math.trunc(tri / (k * 2));
    }
    const gate = Math.floor(n / 1600) % 2 === 0 ? 100 : 35;
    const attack = n < 80 ? Math.trunc((n * 100) / 80) : 100;
    v = Math.trunc((Math.trunc((v * gate) / 100) * attack) / 100);
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5; rng >>>= 0;
    const noise = Math.trunc(((rng >>> 16) - 0x8000) / 16);
    const s = Math.trunc(v / 8) + noise;
    pcm[n] = Math.max(-32768, Math.min(32767, s));
  }
  return pcm;
}

/** Render a QrMatrix to RGBA pixels (integer scale, quiet zone). */
export function renderPixels(matrix, scale = 6, quiet = 4) {
  const dim = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = 255;
  }
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y * matrix.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const o = (py * dim + px) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

/** Compare decoded PCM with a reference, allowing FP drift (see
 *  core/tests/golden.rs for the measured basis of these thresholds). */
export function pcmDiffStats(actual, expected) {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / expected.length };
}
