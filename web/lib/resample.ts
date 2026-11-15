/**
 * Grayscale conversion + Lanczos-3 upscaling (pure pixel math, no DOM).
 *
 * Used by the scale-ladder retry in qr.ts. A QR reader tuned for camera
 * input sometimes rejects a dense code at an image's native scale while
 * accepting the same code presented larger: upscaling adds no
 * information, it moves the presentation into the reader's working
 * regime (the digital equivalent of moving a camera closer). Lanczos-3
 * is the resampler because it preserves module edges better than linear
 * or cubic interpolation.
 */
import type { PixelData } from './qr.js';

/** Presented widths (px) the retry ladder tries, ascending. */
export const LADDER_WIDTHS: readonly number[] = [1800, 2600, 3400, 4200];

/**
 * Hard cap on a presented image's pixel count. iOS Safari silently
 * refuses canvases above 16,777,216 px, and very large inputs also
 * strain the reader's wasm memory, so ladder steps stay under this.
 */
export const MAX_PRESENTED_AREA = 16_000_000;

/**
 * A ladder step must exceed the native width by at least this factor:
 * a closer step lands in the same reader regime as the native image
 * and is not worth a read attempt.
 */
const MIN_GAIN = 1.2;

/**
 * The ladder steps worth trying for an image of the given size, as
 * presented widths. Empty when the image is already large (a
 * high-resolution frame whose code fills it needs no retry) or when
 * every step would exceed the area cap.
 */
export function ladderWidthsFor(width: number, height: number): number[] {
  const out: number[] = [];
  for (const w of LADDER_WIDTHS) {
    if (w <= width * MIN_GAIN) continue;
    const h = Math.round((height * w) / width);
    if (w * h > MAX_PRESENTED_AREA) continue;
    out.push(w);
  }
  return out;
}

function lanczos3(x: number): number {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
}

interface AxisTap {
  /** First source index contributing to this output index. */
  start: number;
  /** Normalised weights for source indices start..start+len-1. */
  weights: Float32Array;
}

/** Precompute Lanczos-3 taps for one axis (upscaling only: dst > src). */
function axisTaps(srcLen: number, dstLen: number): AxisTap[] {
  const scale = srcLen / dstLen;
  const taps: AxisTap[] = [];
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.ceil(center - 3));
    const hi = Math.min(srcLen - 1, Math.floor(center + 3));
    const weights = new Float32Array(hi - lo + 1);
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const w = lanczos3(center - j);
      weights[j - lo] = w;
      sum += w;
    }
    for (let k = 0; k < weights.length; k++) weights[k] /= sum;
    taps.push({ start: lo, weights });
  }
  return taps;
}

/** BT.601 luma (the same weights the QR reader derives internally). */
export function toGrayscale(image: PixelData): Uint8Array {
  const { data, width, height } = image;
  const gray = new Uint8Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    gray[i] =
      (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Upscale an image to the given width with Lanczos-3 (aspect preserved),
 * returned as grayscale RGBA pixels (R=G=B, A=255) ready for the reader.
 */
export function upscaleToWidth(image: PixelData, targetWidth: number): PixelData {
  const srcW = image.width;
  const srcH = image.height;
  const dstW = targetWidth;
  const dstH = Math.round((srcH * targetWidth) / srcW);
  const gray = toGrayscale(image);

  // Horizontal pass: srcW x srcH -> dstW x srcH (float intermediate).
  const xTaps = axisTaps(srcW, dstW);
  const mid = new Float32Array(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcW;
    const midRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const tap = xTaps[x];
      let acc = 0;
      for (let k = 0; k < tap.weights.length; k++) {
        acc += gray[srcRow + tap.start + k] * tap.weights[k];
      }
      mid[midRow + x] = acc;
    }
  }

  // Vertical pass: dstW x srcH -> dstW x dstH, expanded to RGBA.
  const yTaps = axisTaps(srcH, dstH);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const tap = yTaps[y];
    for (let x = 0; x < dstW; x++) {
      let acc = 0;
      for (let k = 0; k < tap.weights.length; k++) {
        acc += mid[(tap.start + k) * dstW + x] * tap.weights[k];
      }
      const v = acc < 0 ? 0 : acc > 255 ? 255 : Math.round(acc);
      const o = (y * dstW + x) * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: dstW, height: dstH };
}
