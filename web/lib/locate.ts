/**
 * QR localization: estimate where a QR code sits in a large image, so
 * the reader can be given a crop instead of the whole frame.
 *
 * The reader (zxing) does not report where a FAILED candidate was, so
 * when a big photo's direct read fails there is no position to crop
 * from. This module finds the position the classical way — the same
 * first step every QR detector takes: scan binarised rows for the
 * finder pattern's 1:1:3:1:1 run-length ratio, cross-check each
 * candidate vertically, cluster the survivors, and keep the three
 * clusters that form a finder's right-isosceles triangle.
 *
 * The result is deliberately approximate: the crop only has to contain
 * the whole code plus its quiet zone. Precision work (sampling,
 * error correction) stays with the reader. A miss or a false positive
 * costs a few extra read attempts; the caller's behaviour is otherwise
 * unchanged.
 */
import type { PixelData } from './qr.js';
import { toGrayscale } from './resample.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Otsu threshold over a sampled histogram of the grayscale image. */
function otsuThreshold(gray: Uint8Array, width: number, height: number): number {
  const hist = new Float64Array(256);
  const step = 4;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      hist[gray[row + x]]++;
      total++;
    }
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

interface Run {
  start: number;
  length: number;
  dark: boolean;
}

/** Run-length encode one binarised row (dark = gray <= threshold). */
function rowRuns(
  gray: Uint8Array,
  width: number,
  y: number,
  threshold: number,
): Run[] {
  const runs: Run[] = [];
  const row = y * width;
  let dark = gray[row] <= threshold;
  let start = 0;
  for (let x = 1; x < width; x++) {
    const d = gray[row + x] <= threshold;
    if (d !== dark) {
      runs.push({ start, length: x - start, dark });
      start = x;
      dark = d;
    }
  }
  runs.push({ start, length: width - start, dark });
  return runs;
}

/**
 * Does a 5-run window match the finder ratio 1:1:3:1:1 (dark first)?
 * Returns the module size (total / 7) or 0. Tolerances are generous —
 * blur and perspective distort run lengths well beyond the textbook
 * ratios, and a distant finder may be several percent foreshortened.
 * Discrimination against the many accidental matches this admits is
 * left to candidate density, module consistency, and the finder
 * triangle's geometry.
 */
function finderModule(runs: Run[], i: number): number {
  const [a, b, c, d, e] = [runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4]];
  if (!a.dark || b.dark || !c.dark || d.dark || !e.dark) return 0;
  const total = a.length + b.length + c.length + d.length + e.length;
  const unit = total / 7;
  if (unit < 1.5) return 0;
  const outer = unit * 0.7;
  if (Math.abs(a.length - unit) > outer) return 0;
  if (Math.abs(b.length - unit) > outer) return 0;
  if (Math.abs(d.length - unit) > outer) return 0;
  if (Math.abs(e.length - unit) > outer) return 0;
  if (Math.abs(c.length - 3 * unit) > 3 * unit * 0.6) return 0;
  return unit;
}

interface Candidate {
  x: number;
  y: number;
  module: number;
}

/**
 * Vertical cross-check: within ±4 modules of (cx, y) along the column,
 * is there a 1:1:3:1:1 window whose centre lands near y? Returns the
 * refined centre y and module, or null.
 */
function verticalCheck(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  cx: number,
  y: number,
  module: number,
): { y: number; module: number } | null {
  const x = Math.round(cx);
  const span = Math.ceil(module * 5);
  const y0 = Math.max(0, y - span);
  const y1 = Math.min(height - 1, y + span);
  const runs: Run[] = [];
  let dark = gray[y0 * width + x] <= threshold;
  let start = y0;
  for (let yy = y0 + 1; yy <= y1; yy++) {
    const d = gray[yy * width + x] <= threshold;
    if (d !== dark) {
      runs.push({ start, length: yy - start, dark });
      start = yy;
      dark = d;
    }
  }
  runs.push({ start, length: y1 - start + 1, dark });
  for (let i = 0; i + 4 < runs.length; i++) {
    const unit = finderModule(runs, i);
    if (unit === 0) continue;
    if (Math.abs(unit - module) > module * 0.6) continue;
    const c = runs[i + 2];
    const center = c.start + c.length / 2;
    if (Math.abs(center - y) <= module * 1.5) {
      return { y: center, module: unit };
    }
  }
  return null;
}

interface Cluster {
  x: number;
  y: number;
  module: number;
  count: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clusterCandidates(candidates: Candidate[]): Cluster[] {
  // Density filter: a real finder is hit by many scan rows in a tight
  // neighbourhood; accidental matches inside the data field are
  // comparatively sparse, and chaining (a cluster centre wandering
  // into the interior) is prevented by grouping only dense points.
  const dense = candidates.filter((cand) => {
    const radius = cand.module * 2.5;
    let neighbours = 0;
    for (const other of candidates) {
      if (
        other !== cand &&
        Math.abs(other.x - cand.x) <= radius &&
        Math.abs(other.y - cand.y) <= radius
      ) {
        neighbours++;
        if (neighbours >= 4) return true;
      }
    }
    return false;
  });
  // Connected components over the survivors (link = 1.5 modules);
  // centres are medians, robust against residual outliers.
  const assigned = new Array(dense.length).fill(false);
  const clusters: Cluster[] = [];
  for (let i = 0; i < dense.length; i++) {
    if (assigned[i]) continue;
    const group: Candidate[] = [dense[i]];
    assigned[i] = true;
    for (let g = 0; g < group.length; g++) {
      for (let j = 0; j < dense.length; j++) {
        if (assigned[j]) continue;
        const link = Math.max(group[g].module, dense[j].module) * 1.5;
        if (
          Math.abs(group[g].x - dense[j].x) <= link &&
          Math.abs(group[g].y - dense[j].y) <= link
        ) {
          assigned[j] = true;
          group.push(dense[j]);
        }
      }
    }
    if (group.length >= 3) {
      clusters.push({
        x: median(group.map((c) => c.x)),
        y: median(group.map((c) => c.y)),
        module: median(group.map((c) => c.module)),
        count: group.length,
      });
    }
  }
  return clusters;
}

/** Do three clusters sit at the corners of a right isosceles triangle? */
function isFinderTriple(a: Cluster, b: Cluster, c: Cluster): boolean {
  const d = [
    Math.hypot(a.x - b.x, a.y - b.y),
    Math.hypot(b.x - c.x, b.y - c.y),
    Math.hypot(a.x - c.x, a.y - c.y),
  ].sort((p, q) => p - q);
  const [leg1, leg2, hyp] = d;
  if (leg1 < 20) return false;
  if (Math.abs(leg1 - leg2) > Math.max(leg1, leg2) * 0.4) return false;
  if (Math.abs(hyp - leg1 * Math.SQRT2) > leg1 * Math.SQRT2 * 0.45) return false;
  return true;
}

/**
 * Locate a QR code in the image. Returns a crop rectangle containing
 * the code plus margin (finder inset + quiet zone + safety), or null
 * when no plausible finder triple exists.
 */
export function locateQr(image: PixelData): Rect | null {
  const { width, height } = image;
  const gray = toGrayscale(image);
  const threshold = otsuThreshold(gray, width, height);

  // Horizontal scan: every row at photo sizes (a finder spans only a
  // few dozen rows, and sparse strides starve its candidate count);
  // the stride grows with area to bound the total work.
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / 12_500_000)));
  const candidates: Candidate[] = [];
  for (let y = 0; y < height; y += stride) {
    const runs = rowRuns(gray, width, y, threshold);
    for (let i = 0; i + 4 < runs.length; i++) {
      const unit = finderModule(runs, i);
      if (unit === 0) continue;
      const c = runs[i + 2];
      const cx = c.start + c.length / 2;
      const refined = verticalCheck(gray, width, height, threshold, cx, y, unit);
      if (refined) {
        candidates.push({ x: cx, y: refined.y, module: (unit + refined.module) / 2 });
      }
    }
  }
  if (candidates.length === 0) return null;

  const clusters = clusterCandidates(candidates);
  if (clusters.length < 3) return null;

  // Best finder triple by total supporting hits.
  let best: [Cluster, Cluster, Cluster] | null = null;
  let bestScore = -1;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      for (let k = j + 1; k < clusters.length; k++) {
        const triple: [Cluster, Cluster, Cluster] = [clusters[i], clusters[j], clusters[k]];
        const mods = triple.map((t) => t.module);
        if (Math.max(...mods) / Math.min(...mods) > 1.6) continue;
        if (!isFinderTriple(...triple)) continue;
        const score = triple[0].count + triple[1].count + triple[2].count;
        if (score > bestScore) {
          bestScore = score;
          best = triple;
        }
      }
    }
  }
  if (!best) return null;

  const module = (best[0].module + best[1].module + best[2].module) / 3;
  const minX = Math.min(best[0].x, best[1].x, best[2].x);
  const maxX = Math.max(best[0].x, best[1].x, best[2].x);
  const minY = Math.min(best[0].y, best[1].y, best[2].y);
  const maxY = Math.max(best[0].y, best[1].y, best[2].y);
  // Finder centres sit 3.5 modules inside the code edge; the margin
  // covers that inset, the 4-module quiet zone, and centre-estimation
  // error, on every side.
  const margin = module * 12;
  const x0 = Math.max(0, Math.floor(minX - margin));
  const y0 = Math.max(0, Math.floor(minY - margin));
  const x1 = Math.min(width, Math.ceil(maxX + margin));
  const y1 = Math.min(height, Math.ceil(maxY + margin));
  const rect: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  // A crop that barely shrinks the frame gains nothing.
  if (rect.width * rect.height > width * height * 0.95) return null;
  if (rect.width < 100 || rect.height < 100) return null;
  return rect;
}

/** Copy a rectangular region out of an RGBA pixel image. */
export function cropImage(image: PixelData, rect: Rect): PixelData {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y++) {
    const src = ((rect.y + y) * image.width + rect.x) * 4;
    out.set(image.data.subarray(src, src + rowBytes), y * rowBytes);
  }
  return { data: out, width: rect.width, height: rect.height };
}
