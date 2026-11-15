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
  /** Pixels per module. Default 4. */
  modulePx?: number;
  /** Quiet-zone width in modules. Default 4. */
  quietZone?: number;
}

/** Draw a QrMatrix on a canvas: integer scaling, quiet zone included. */
export function drawQr(
  canvas: HTMLCanvasElement,
  matrix: QrMatrix,
  options?: DrawOptions,
): void {
  const modulePx = options?.modulePx ?? 4;
  const quiet = options?.quietZone ?? 4;
  const dim = (matrix.size + quiet * 2) * modulePx;
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
        ctx.fillRect((x + quiet) * modulePx, (y + quiet) * modulePx, modulePx, modulePx);
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
