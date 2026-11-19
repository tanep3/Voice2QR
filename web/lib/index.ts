/**
 * Voice2QR JS library — public API (docs/js-api.md, frozen 2026-11-14).
 *
 * Turns recorded voice (8 kHz mono PCM) into QV payloads and QR module
 * matrices, and back. Environment-independent: DOM helpers live in the
 * separate `voice2qr/browser` entry.
 */
import { CoreBridge } from './bridge.js';
import { Voice2QrError } from './errors.js';
import {
  payloadToQr as toQr,
  qrToPayload as fromPixels,
  qrToPayloadDetailed as fromPixelsDetailed,
  QR_CAPACITY,
  type EcLevel,
  type PixelData,
  type QrMatrix,
  type QrReadOptions,
  type QrReadResult,
} from './qr.js';

export { Voice2QrError, type ErrorCode } from './errors.js';
export type { EcLevel, PixelData, QrMatrix, QrReadOptions, QrReadResult };

export interface CreateOptions {
  /** Core wasm URL. Default: resolved relative to this module. */
  coreUrl?: string;
  /** Codec2 wasm URL. Default: resolved relative to this module. */
  codec2Url?: string;
}

export interface EncodeOptions {
  /** Codec2 bit rate. Default 1200. */
  bps?: number;
  /** QR error-correction level; sets the payload capacity. Default 'M'. */
  ecLevel?: EcLevel;
}

export interface VoiceInfo {
  bps: number;
  frames: number;
  durationMs: number;
}

export interface Info {
  version: number;
  voice?: VoiceInfo;
  hasText: boolean;
  hasImage: boolean;
}

export interface Encoder {
  push(pcm: Int16Array): Promise<void>;
  readonly framesEncoded: number;
  readonly payloadBytes: number;
  finish(): Promise<Uint8Array>;
}

export interface Voice2Qr {
  readonly version: { library: string; format: number };
  inspect(payload: Uint8Array): Promise<Info>;
  encode(pcm: Int16Array, options?: EncodeOptions): Promise<Uint8Array>;
  createEncoder(options?: EncodeOptions): Encoder;
  decode(payload: Uint8Array): Promise<Int16Array>;
  maxDurationMs(options?: EncodeOptions): Promise<number>;
  payloadToQr(payload: Uint8Array, options?: { ecLevel?: EcLevel }): Promise<QrMatrix>;
  qrToPayload(image: PixelData, options?: QrReadOptions): Promise<Uint8Array>;
  /**
   * Like qrToPayload, but also reports the error-correction level of
   * the symbol that was read (null when the reader did not report a
   * usable level). Passing that level to payloadToQr re-generates an
   * equivalent symbol at the same level — e.g. to rescue a fading
   * printed code.
   */
  readQr(image: PixelData, options?: QrReadOptions): Promise<QrReadResult>;
}

const LIBRARY_VERSION = '0.2.0';
const FORMAT_VERSION = 2;
const DEFAULT_BPS = 1200;
const DEFAULT_EC: EcLevel = 'M';

function checkPcm(pcm: unknown): asserts pcm is Int16Array {
  if (!(pcm instanceof Int16Array)) {
    throw new Voice2QrError('INVALID_ARGUMENT', 'pcm must be an Int16Array');
  }
}

function checkImage(image: unknown): asserts image is PixelData {
  const img = image as PixelData | null | undefined;
  if (
    !img ||
    !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) ||
    !Number.isInteger(img.width) ||
    !Number.isInteger(img.height) ||
    img.width <= 0 ||
    img.height <= 0
  ) {
    throw new Voice2QrError('INVALID_ARGUMENT', 'image must be { data, width, height }');
  }
}

function checkPayload(payload: unknown): asserts payload is Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    throw new Voice2QrError('INVALID_ARGUMENT', 'payload must be a Uint8Array');
  }
}

function resolveOptions(options?: EncodeOptions): { bps: number; capacity: number } {
  const bps = options?.bps ?? DEFAULT_BPS;
  const ecLevel = options?.ecLevel ?? DEFAULT_EC;
  if (!Number.isInteger(bps) || bps <= 0) {
    throw new Voice2QrError('INVALID_ARGUMENT', `invalid bps: ${bps}`);
  }
  if (!(ecLevel in QR_CAPACITY)) {
    throw new Voice2QrError('INVALID_ARGUMENT', `invalid ecLevel: ${ecLevel}`);
  }
  return { bps, capacity: QR_CAPACITY[ecLevel] };
}

class EncoderImpl implements Encoder {
  private handle: number | null;
  private bridge: CoreBridge;
  private _framesEncoded = 0;
  private _payloadBytes: number;

  constructor(bridge: CoreBridge, bps: number, capacity: number) {
    this.bridge = bridge;
    this.handle = bridge.encoderNew(bps, capacity);
    this._payloadBytes = bridge.encoderStats(this.handle).payloadBytes;
  }

  get framesEncoded(): number {
    return this._framesEncoded;
  }

  get payloadBytes(): number {
    return this._payloadBytes;
  }

  async push(pcm: Int16Array): Promise<void> {
    if (this.handle === null) {
      throw new Voice2QrError('INVALID_ARGUMENT', 'encoder already finished');
    }
    checkPcm(pcm);
    this.bridge.encoderPush(this.handle, pcm);
    const stats = this.bridge.encoderStats(this.handle);
    this._framesEncoded = stats.frames;
    this._payloadBytes = stats.payloadBytes;
  }

  async finish(): Promise<Uint8Array> {
    if (this.handle === null) {
      throw new Voice2QrError('INVALID_ARGUMENT', 'encoder already finished');
    }
    const handle = this.handle;
    this.handle = null; // finalize consumes the handle either way
    return this.bridge.encoderFinalize(handle);
  }
}

class Voice2QrImpl implements Voice2Qr {
  readonly version = { library: LIBRARY_VERSION, format: FORMAT_VERSION };
  private bridge: CoreBridge;
  private zxingWasmHref: string;

  constructor(bridge: CoreBridge, zxingWasmHref: string) {
    this.bridge = bridge;
    this.zxingWasmHref = zxingWasmHref;
  }

  async inspect(payload: Uint8Array): Promise<Info> {
    checkPayload(payload);
    const raw = this.bridge.inspect(payload);
    return {
      version: raw.version,
      voice: raw.voice
        ? { bps: raw.voice.bps, frames: raw.voice.frames, durationMs: raw.voice.durationMs }
        : undefined,
      hasText: raw.hasText,
      hasImage: raw.hasImage,
    };
  }

  async encode(pcm: Int16Array, options?: EncodeOptions): Promise<Uint8Array> {
    checkPcm(pcm);
    const { bps, capacity } = resolveOptions(options);
    return this.bridge.encode(pcm, bps, capacity);
  }

  createEncoder(options?: EncodeOptions): Encoder {
    const { bps, capacity } = resolveOptions(options);
    return new EncoderImpl(this.bridge, bps, capacity);
  }

  async decode(payload: Uint8Array): Promise<Int16Array> {
    checkPayload(payload);
    return this.bridge.decode(payload);
  }

  async maxDurationMs(options?: EncodeOptions): Promise<number> {
    const { bps, capacity } = resolveOptions(options);
    return this.bridge.maxDurationMs(bps, capacity);
  }

  async payloadToQr(
    payload: Uint8Array,
    options?: { ecLevel?: EcLevel },
  ): Promise<QrMatrix> {
    checkPayload(payload);
    return toQr(payload, options?.ecLevel ?? DEFAULT_EC);
  }

  async qrToPayload(image: PixelData, options?: QrReadOptions): Promise<Uint8Array> {
    checkImage(image);
    return fromPixels(image, this.zxingWasmHref, options);
  }

  async readQr(image: PixelData, options?: QrReadOptions): Promise<QrReadResult> {
    checkImage(image);
    return fromPixelsDetailed(image, this.zxingWasmHref, options);
  }
}

/**
 * Initialize the library: loads the core wasm and codec2.wasm and links
 * them. Call once at startup.
 */
export async function createVoice2Qr(options?: CreateOptions): Promise<Voice2Qr> {
  const coreHref = new URL(
    options?.coreUrl ?? './voice2qr_core.wasm',
    import.meta.url,
  ).href;
  const codec2Href = new URL(
    options?.codec2Url ?? './codec2.wasm',
    import.meta.url,
  ).href;
  const zxingWasmHref = new URL('./zxing_reader.wasm', import.meta.url).href;
  let bridge: CoreBridge;
  try {
    bridge = await CoreBridge.create(coreHref, codec2Href);
  } catch (e) {
    if (e instanceof Voice2QrError) throw e;
    throw new Voice2QrError(
      'LOAD',
      `failed to load wasm modules: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return new Voice2QrImpl(bridge, zxingWasmHref);
}
