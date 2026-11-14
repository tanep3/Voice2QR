/**
 * QR conversion (internal building blocks for the public API):
 * payload -> module matrix via Nayuki's qrcodegen (vendored, MIT —
 * lib/vendor/), and pixels -> payload via zxing-wasm (zxing-cpp,
 * Apache-2.0; reader wasm is co-located with the library, never a CDN).
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { Voice2QrError } from './errors.js';
import { loadBytes } from './bridge.js';
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

export async function qrToPayload(
  image: PixelData,
  zxingWasmHref: string,
): Promise<Uint8Array> {
  await ensureZxing(zxingWasmHref);
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
      return new Uint8Array(r.bytes);
    }
  }
  throw new Voice2QrError('QR_NOT_FOUND', 'no QR code found in the image');
}
