/**
 * Browser helpers (docs/js-api.md §4) — the DOM-touching entry point,
 * kept separate from the environment-independent library core.
 */
import { Voice2QrError } from './errors.js';
import {
  payloadToQr as toQr,
  qrToPayload as fromPixels,
  type EcLevel,
  type QrMatrix,
  type QrReadOptions,
} from './qr.js';

export type { EcLevel, QrMatrix, QrReadOptions };

export interface DrawOptions {
  /** Pixels per module. Default 4. Ignored when printWidth is set. */
  modulePx?: number;
  /** Quiet-zone width in modules. Default 4. */
  quietZone?: number;
  /**
   * Printer-optimized output: the canvas is exactly this many pixels
   * wide (a printer's printable dot width, e.g. 384 or 576), and the
   * QR is drawn centered at the largest whole number of pixels per
   * module that fits. A thermal printer's app then scales the image
   * by exactly 1.0, so every module lands on whole printer dots.
   */
  printWidth?: number;
}

export interface PrintLayout {
  /** Whole pixels per module (≥ 1). */
  modulePx: number;
  /** Left/top offset of the QR (incl. quiet zone) on the canvas, in px. */
  offsetPx: number;
  /** Canvas width/height in px — the requested target width. */
  canvasPx: number;
}

/**
 * Layout for printer-optimized output: the largest integer pixels per
 * module whose total (modules incl. quiet zone) fits the target width,
 * centered with an integer-pixel offset (margins may differ by 1 px;
 * the quiet zone stays intact on both sides).
 */
export function printLayout(totalModules: number, targetWidth: number): PrintLayout {
  const modulePx = Math.max(1, Math.floor(targetWidth / totalModules));
  const used = totalModules * modulePx;
  const offsetPx = Math.floor((targetWidth - used) / 2);
  return { modulePx, offsetPx, canvasPx: targetWidth };
}

/** Draw a QrMatrix on a canvas: integer scaling, quiet zone included. */
export function drawQr(
  canvas: HTMLCanvasElement,
  matrix: QrMatrix,
  options?: DrawOptions,
): void {
  const quiet = options?.quietZone ?? 4;
  const total = matrix.size + quiet * 2;
  let modulePx = options?.modulePx ?? 4;
  let dim = total * modulePx;
  let offset = 0;
  if (options?.printWidth !== undefined) {
    const layout = printLayout(total, options.printWidth);
    modulePx = layout.modulePx;
    dim = layout.canvasPx;
    offset = layout.offsetPx;
  }
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Voice2QrError('INVALID_ARGUMENT', 'canvas has no 2d context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y * matrix.size + x]) {
        ctx.fillRect(
          offset + (x + quiet) * modulePx,
          offset + (y + quiet) * modulePx,
          modulePx,
          modulePx,
        );
      }
    }
  }
}

/** Build a PNG Blob from a payload (for saving / sharing / printing). */
export async function payloadToPng(
  payload: Uint8Array,
  options?: DrawOptions & { ecLevel?: EcLevel },
): Promise<Blob> {
  const matrix = toQr(payload, options?.ecLevel ?? 'M');
  const canvas = document.createElement('canvas');
  drawQr(canvas, matrix, options);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Voice2QrError('INVALID_ARGUMENT', 'PNG encoding failed');
  return blob;
}

/** Read a payload from an ImageData (e.g. from a canvas or camera frame). */
export async function readPayloadFromImageData(
  imageData: ImageData,
  options?: QrReadOptions,
): Promise<Uint8Array> {
  const href = new URL('./zxing_reader.wasm', import.meta.url).href;
  return fromPixels(
    { data: imageData.data, width: imageData.width, height: imageData.height },
    href,
    options,
  );
}
