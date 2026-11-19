/**
 * QR conversion (internal building blocks for the public API):
 * payload -> module matrix via Nayuki's qrcodegen (vendored, MIT —
 * lib/vendor/), and pixels -> payload via zxing-wasm (zxing-cpp,
 * Apache-2.0; reader wasm is co-located with the library, never a CDN).
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { Voice2QrError } from './errors.js';
import { loadBytes } from './bridge.js';
import { cropImage, locateQr } from './locate.js';
import { ladderWidthsFor, upscaleToWidth } from './resample.js';
import { qrcodegen } from './vendor/qrcodegen.js';

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  version: number;
  size: number;
  modules: Uint8Array;
  ecLevel: EcLevel;
}

export interface PixelData {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

const ECC: Record<EcLevel, qrcodegen.QrCode.Ecc> = {
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
};

/** Byte capacity of a QR at each error-correction level (docs/js-api.md §6). */
export const QR_CAPACITY: Record<EcLevel, number> = {
  L: 2953,
  M: 2331,
  Q: 1663,
  H: 1273,
};

export function payloadToQr(payload: Uint8Array, ecLevel: EcLevel): QrMatrix {
  let qr: qrcodegen.QrCode;
  try {
    qr = qrcodegen.QrCode.encodeBinary([...payload], ECC[ecLevel]);
  } catch {
    throw new Voice2QrError(
      'QR_TOO_LARGE',
      `payload of ${payload.length} bytes exceeds QR capacity at level ${ecLevel}`,
    );
  }
  const modules = new Uint8Array(qr.size * qr.size);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      modules[y * qr.size + x] = qr.getModule(x, y) ? 1 : 0;
    }
  }
  return { version: qr.version, size: qr.size, modules, ecLevel };
}

let zxingReady: Promise<void> | null = null;

function ensureZxing(zxingWasmHref: string): Promise<void> {
  if (!zxingReady) {
    zxingReady = (async () => {
      // slice(): an exact-size copy whose .buffer is precisely the wasm
      // (a pooled Buffer's backing store could be larger).
      const wasmBinary = (await loadBytes(zxingWasmHref)).slice().buffer;
      await prepareZXingModule({
        overrides: { wasmBinary: wasmBinary as ArrayBuffer },
        fireImmediately: true,
      });
    })();
  }
  return zxingReady;
}

export interface QrReadOptions {
  /**
   * When the direct read fails, retry harder: first locate the code
   * and retry on the crop and on ladder-rescaled crops (see
   * locate.ts); then retry the full image re-presented at a ladder of
   * larger widths (Lanczos-3 upscale, area-capped — see
   * resample.ts). The reader is tuned for camera-scale presentations;
   * a dense code occupying part of the frame, or a small or
   * low-resolution image, can fall outside its working regime at
   * native scale while reading fine cropped and presented larger.
   * Off by default; enabling it only adds attempts after a failed
   * direct read, and a hit is still the reader's own
   * checksum-verified decode.
   */
  scaleRetry?: boolean;
}

export interface QrReadResult {
  payload: Uint8Array;
  /**
   * Error-correction level of the symbol that was read, taken from its
   * format information; null when the reader did not report a usable
   * level. Feeding it back into payloadToQr reproduces the symbol at
   * the same level, so a re-generated copy always fits its payload.
   */
  ecLevel: EcLevel | null;
}

function asEcLevel(v: unknown): EcLevel | null {
  return v === 'L' || v === 'M' || v === 'Q' || v === 'H' ? v : null;
}

async function tryRead(image: PixelData): Promise<QrReadResult | null> {
  const imageData = {
    data: image.data,
    width: image.width,
    height: image.height,
    colorSpace: 'srgb' as const,
  };
  const results = await readBarcodes(imageData as ImageData, {
    formats: ['QRCode'],
    tryHarder: true,
  });
  for (const r of results) {
    if (r.format === 'QRCode' && r.bytes.length > 0) {
      return { payload: new Uint8Array(r.bytes), ecLevel: asEcLevel(r.ecLevel) };
    }
  }
  return null;
}

export async function qrToPayloadDetailed(
  image: PixelData,
  zxingWasmHref: string,
  options?: QrReadOptions,
): Promise<QrReadResult> {
  await ensureZxing(zxingWasmHref);
  const direct = await tryRead(image);
  if (direct) return direct;
  if (options?.scaleRetry) {
    // Localization runs at any frame size: the code may occupy only
    // part of the frame (a photo, or a camera frame where the user
    // holds the print at a distance), where the full-frame ladder
    // spends most of its pixels on the surroundings. No candidate —
    // or a crop that does not decode — simply falls through to the
    // full-frame ladder.
    const rect = locateQr(image);
    if (rect) {
      const crop = cropImage(image, rect);
      const hitCrop = await tryRead(crop);
      if (hitCrop) return hitCrop;
      for (const w of ladderWidthsFor(crop.width, crop.height)) {
        const hit = await tryRead(upscaleToWidth(crop, w));
        if (hit) return hit;
      }
      // Safety net for a wrong crop: one full-frame step. When the
      // crop was the real code, the full frame at a similar pitch
      // adds nothing the crop ladder did not already try, so the
      // remaining steps are not worth their cost on the failure path.
      const first = ladderWidthsFor(image.width, image.height)[0];
      if (first !== undefined) {
        const hit = await tryRead(upscaleToWidth(image, first));
        if (hit) return hit;
      }
    } else {
      for (const w of ladderWidthsFor(image.width, image.height)) {
        const hit = await tryRead(upscaleToWidth(image, w));
        if (hit) return hit;
      }
    }
  }
  throw new Voice2QrError('QR_NOT_FOUND', 'no QR code found in the image');
}

export async function qrToPayload(
  image: PixelData,
  zxingWasmHref: string,
  options?: QrReadOptions,
): Promise<Uint8Array> {
  return (await qrToPayloadDetailed(image, zxingWasmHref, options)).payload;
}
