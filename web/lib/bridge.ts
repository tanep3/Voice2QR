/**
 * The wasm bridge (internal): loads codec2.wasm and the core wasm,
 * links them through JS (docs/system-design.md §3), and wraps the
 * core's C ABI in typed calls.
 *
 * The two modules have separate memories. codec2 functions are handed
 * to the core as imports; the encode/decode imports copy one frame at
 * a time through scratch buffers inside codec2 memory (frame copies
 * are negligible — at most 640 B). All other imports pass through.
 */
import { errorFromCoreStatus, Voice2QrError } from './errors.js';

export interface CoreVoiceInfo {
  bps: number;
  frames: number;
  durationMs: number;
}

export interface CoreInfo {
  version: number;
  voice?: CoreVoiceInfo;
  hasText: boolean;
  hasImage: boolean;
}

/** Fetch wasm bytes from an href: file: in Node, http(s):/data: via fetch. */
export async function loadBytes(href: string): Promise<Uint8Array> {
  if (href.startsWith('file:')) {
    // Node only — browsers never produce file: hrefs here. The dynamic
    // import keeps node builtins out of the browser path entirely.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return new Uint8Array(await readFile(fileURLToPath(href)));
  }
  const res = await fetch(href);
  if (!res.ok) throw new Error(`fetch failed (${res.status}): ${href}`);
  return new Uint8Array(await res.arrayBuffer());
}

type CoreExports = {
  memory: WebAssembly.Memory;
  qv_inspect: (payload: number, len: number, out: number) => number;
  qv_decode: (payload: number, len: number, out: number) => number;
  qv_encode: (
    pcm: number,
    samples: number,
    bps: number,
    capacity: number,
    out: number,
  ) => number;
  qv_encoder_new: (bps: number, capacity: number, out: number) => number;
  qv_encoder_push: (enc: number, pcm: number, samples: number) => number;
  qv_encoder_stats: (enc: number, frames: number, payloadLen: number) => number;
  qv_encoder_finalize: (enc: number, out: number) => number;
  qv_encoder_free: (enc: number) => void;
  qv_bytes_free: (b: number) => void;
  qv_max_duration_ms: (bps: number, capacity: number) => number;
  qv_wasm_alloc: (size: number) => number;
  qv_wasm_free: (ptr: number, size: number) => void;
};

type Codec2Exports = {
  memory: WebAssembly.Memory;
  codec2_create: (mode: number) => number;
  codec2_destroy: (state: number) => void;
  codec2_encode: (state: number, bits: number, speech: number) => void;
  codec2_decode: (state: number, speech: number, bits: number) => void;
  codec2_samples_per_frame: (state: number) => number;
  codec2_bits_per_frame: (state: number) => number;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  _initialize?: () => void;
};

const QV_OK = 0;

export class CoreBridge {
  private core: CoreExports;

  private constructor(core: CoreExports) {
    this.core = core;
  }

  static async create(coreHref: string, codec2Href: string): Promise<CoreBridge> {
    const [coreBytes, codec2Bytes] = await Promise.all([
      loadBytes(coreHref),
      loadBytes(codec2Href),
    ]);

    // 1) codec2.wasm first (standalone Emscripten module: a few WASI
    //    fd stubs and a memory-growth no-op are all it imports).
    const c2instance = new WebAssembly.Instance(
      new WebAssembly.Module(codec2Bytes.slice().buffer as ArrayBuffer),
      {
        env: { emscripten_notify_memory_growth: () => {} },
        wasi_snapshot_preview1: {
          fd_close: () => 0,
          fd_write: () => 0,
          fd_seek: () => 0,
        },
      },
    );
    const c2 = c2instance.exports as unknown as Codec2Exports;
    if (c2._initialize) c2._initialize();

    // Scratch buffers inside codec2 memory, sized for any mode
    // (<= 320 samples = 640 B, <= 8 frame bytes).
    const scratchSamples = c2.malloc(640);
    const scratchBits = c2.malloc(64);

    // 2) The core, with codec2 functions as imports. `coreMemory` is
    //    set right after instantiation; the wrappers are only *called*
    //    later, when both memories exist.
    let coreMemory: WebAssembly.Memory | null = null;
    const coreU8 = () => new Uint8Array(coreMemory!.buffer);
    const c2U8 = () => new Uint8Array(c2.memory.buffer);
    const frameBytes = (state: number) =>
      Math.ceil(c2.codec2_bits_per_frame(state) / 8);
    const env = {
      codec2_create: (mode: number) => c2.codec2_create(mode),
      codec2_destroy: (state: number) => c2.codec2_destroy(state),
      codec2_samples_per_frame: (state: number) =>
        c2.codec2_samples_per_frame(state),
      codec2_bits_per_frame: (state: number) => c2.codec2_bits_per_frame(state),
      codec2_encode: (state: number, bitsPtr: number, speechPtr: number) => {
        const n = c2.codec2_samples_per_frame(state) * 2;
        c2U8().set(coreU8().subarray(speechPtr, speechPtr + n), scratchSamples);
        c2.codec2_encode(state, scratchBits, scratchSamples);
        const b = frameBytes(state);
        coreU8().set(c2U8().subarray(scratchBits, scratchBits + b), bitsPtr);
      },
      codec2_decode: (state: number, speechPtr: number, bitsPtr: number) => {
        const b = frameBytes(state);
        c2U8().set(coreU8().subarray(bitsPtr, bitsPtr + b), scratchBits);
        c2.codec2_decode(state, scratchSamples, scratchBits);
        const n = c2.codec2_samples_per_frame(state) * 2;
        coreU8().set(c2U8().subarray(scratchSamples, scratchSamples + n), speechPtr);
      },
    };
    const coreInstance = new WebAssembly.Instance(
      new WebAssembly.Module(coreBytes.slice().buffer as ArrayBuffer),
      { env },
    );
    const core = coreInstance.exports as unknown as CoreExports;
    coreMemory = core.memory;
    return new CoreBridge(core);
  }

  private get mem(): WebAssembly.Memory {
    return this.core.memory;
  }

  private u8(): Uint8Array {
    return new Uint8Array(this.mem.buffer);
  }

  private alloc(size: number): number {
    const ptr = this.core.qv_wasm_alloc(size);
    if (ptr === 0) throw new Voice2QrError('LOAD', 'core allocation failed');
    return ptr;
  }

  /** Run a call that fills a QvBytes out-struct; return a copy of the bytes. */
  private takeBytes(call: (out: number) => number): Uint8Array {
    const out = this.alloc(8);
    try {
      const status = call(out);
      if (status !== QV_OK) throw errorFromCoreStatus(status);
      const dv = new DataView(this.mem.buffer);
      const ptr = dv.getUint32(out, true);
      const len = dv.getUint32(out + 4, true);
      const bytes = this.u8().slice(ptr, ptr + len);
      this.core.qv_bytes_free(out);
      return bytes;
    } finally {
      this.core.qv_wasm_free(out, 8);
    }
  }

  private withPayload<T>(payload: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.alloc(Math.max(payload.length, 1));
    try {
      this.u8().set(payload, ptr);
      return fn(ptr);
    } finally {
      this.core.qv_wasm_free(ptr, Math.max(payload.length, 1));
    }
  }

  private withPcm<T>(pcm: Int16Array, fn: (ptr: number) => T): T {
    const ptr = this.alloc(Math.max(pcm.length * 2, 1));
    try {
      new Int16Array(this.mem.buffer, ptr, pcm.length).set(pcm);
      return fn(ptr);
    } finally {
      this.core.qv_wasm_free(ptr, Math.max(pcm.length * 2, 1));
    }
  }

  inspect(payload: Uint8Array): CoreInfo {
    return this.withPayload(payload, (ptr) => {
      const out = this.alloc(32);
      try {
        const status = this.core.qv_inspect(ptr, payload.length, out);
        if (status !== QV_OK) throw errorFromCoreStatus(status);
        const dv = new DataView(this.mem.buffer);
        const hasVoice = dv.getInt32(out + 4, true) !== 0;
        return {
          version: dv.getUint8(out),
          voice: hasVoice
            ? {
                bps: dv.getUint16(out + 8, true),
                frames: dv.getUint32(out + 12, true),
                durationMs: dv.getUint32(out + 16, true),
              }
            : undefined,
          hasText: dv.getInt32(out + 20, true) !== 0,
          hasImage: dv.getInt32(out + 24, true) !== 0,
        };
      } finally {
        this.core.qv_wasm_free(out, 32);
      }
    });
  }

  decode(payload: Uint8Array): Int16Array {
    const le = this.withPayload(payload, (ptr) =>
      this.takeBytes((out) => this.core.qv_decode(ptr, payload.length, out)),
    );
    const pcm = new Int16Array(le.length / 2);
    new Uint8Array(pcm.buffer).set(le);
    return pcm;
  }

  encode(pcm: Int16Array, bps: number, capacity: number): Uint8Array {
    return this.withPcm(pcm, (ptr) =>
      this.takeBytes((out) =>
        this.core.qv_encode(ptr, pcm.length, bps, capacity, out),
      ),
    );
  }

  encoderNew(bps: number, capacity: number): number {
    const out = this.alloc(4);
    try {
      const status = this.core.qv_encoder_new(bps, capacity, out);
      if (status !== QV_OK) throw errorFromCoreStatus(status);
      return new DataView(this.mem.buffer).getUint32(out, true);
    } finally {
      this.core.qv_wasm_free(out, 4);
    }
  }

  encoderPush(handle: number, pcm: Int16Array): void {
    this.withPcm(pcm, (ptr) => {
      const status = this.core.qv_encoder_push(handle, ptr, pcm.length);
      if (status !== QV_OK) throw errorFromCoreStatus(status);
    });
  }

  encoderStats(handle: number): { frames: number; payloadBytes: number } {
    const framesPtr = this.alloc(4);
    const lenPtr = this.alloc(4);
    try {
      const status = this.core.qv_encoder_stats(handle, framesPtr, lenPtr);
      if (status !== QV_OK) throw errorFromCoreStatus(status);
      const dv = new DataView(this.mem.buffer);
      return {
        frames: dv.getUint32(framesPtr, true),
        payloadBytes: dv.getUint32(lenPtr, true),
      };
    } finally {
      this.core.qv_wasm_free(framesPtr, 4);
      this.core.qv_wasm_free(lenPtr, 4);
    }
  }

  /** Finalize consumes the handle either way (core contract). */
  encoderFinalize(handle: number): Uint8Array {
    return this.takeBytes((out) => this.core.qv_encoder_finalize(handle, out));
  }

  encoderFree(handle: number): void {
    this.core.qv_encoder_free(handle);
  }

  maxDurationMs(bps: number, capacity: number): number {
    return this.core.qv_max_duration_ms(bps, capacity);
  }
}
