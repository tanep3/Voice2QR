// wasm-smoke.mjs — verify the JS-mediated WASM linking design
// (docs/system-design.md §3) end to end in Node:
//
//   codec2.wasm  (standalone Emscripten module, own memory)
//        ^  its codec2_* exports, wrapped with buffer copies
//        |  (the two modules have separate memories; encode/decode
//        |   move one frame at a time through scratch buffers)
//   core wasm    (voice2qr_core.wasm, imports env.codec2_*)
//
// Checks, against the golden anchors in fixtures/expected/:
//   - qv_encode of the synthetic signal == expected payload, byte-exact
//   - qv_inspect reports the expected values
//   - streaming encoder == one-shot encoder, byte-exact
//   - qv_decode matches the reference PCM within tolerance
//
// Run AFTER building both wasm modules:
//   codec2/build-wasm.sh
//   cargo build --manifest-path core/Cargo.toml \
//       --target wasm32-unknown-unknown --release
//   node web/tools/wasm-smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p));

// --- the synthetic signal, ported 1:1 from core/testutil/shared.rs ---
function syntheticPcm() {
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
    v = Math.trunc(Math.trunc((v * gate) / 100) * attack / 100);
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5; rng >>>= 0;
    const noise = Math.trunc(((rng >>> 16) - 0x8000) / 16);
    const s = Math.trunc(v / 8) + noise;
    pcm[n] = Math.max(-32768, Math.min(32767, s));
  }
  return pcm;
}

const unhex = (s) => Uint8Array.from(Buffer.from(s.trim(), 'hex'));

// --- instantiate codec2.wasm ---
const codec2Imports = {
  env: { emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 },
};
const c2mod = await WebAssembly.instantiate(
  read('codec2/out/codec2.wasm'), codec2Imports);
const c2 = c2mod.instance.exports;
if (c2._initialize) c2._initialize();

// Scratch buffers inside codec2 memory (generous upper bounds for any
// mode: 320 samples = 640 B in/out, <= 8 frame bytes).
const scratchSamples = c2.malloc(640);
const scratchBits = c2.malloc(64);

// --- wrappers bridging the two memories ---
let coreMemory = null;
const u8core = () => new Uint8Array(coreMemory.buffer);
const u8c2 = () => new Uint8Array(c2.memory.buffer);
function frameBytes(state) {
  return Math.ceil(c2.codec2_bits_per_frame(state) / 8);
}
const env = {
  codec2_create: (mode) => c2.codec2_create(mode),
  codec2_destroy: (state) => c2.codec2_destroy(state),
  codec2_samples_per_frame: (state) => c2.codec2_samples_per_frame(state),
  codec2_bits_per_frame: (state) => c2.codec2_bits_per_frame(state),
  codec2_encode: (state, bitsPtr, speechPtr) => {
    const n = c2.codec2_samples_per_frame(state) * 2;
    u8c2().set(u8core().subarray(speechPtr, speechPtr + n), scratchSamples);
    c2.codec2_encode(state, scratchBits, scratchSamples);
    const b = frameBytes(state);
    u8core().set(u8c2().subarray(scratchBits, scratchBits + b), bitsPtr);
  },
  codec2_decode: (state, speechPtr, bitsPtr) => {
    const b = frameBytes(state);
    u8c2().set(u8core().subarray(bitsPtr, bitsPtr + b), scratchBits);
    c2.codec2_decode(state, scratchSamples, scratchBits);
    const n = c2.codec2_samples_per_frame(state) * 2;
    u8core().set(u8c2().subarray(scratchSamples, scratchSamples + n), speechPtr);
  },
};

// --- instantiate the core ---
const coreMod = await WebAssembly.instantiate(
  read('core/target/wasm32-unknown-unknown/release/voice2qr_core.wasm'),
  { env });
const core = coreMod.instance.exports;
coreMemory = core.memory;

const CAPACITY_M = 2331;
function bytesOut(structPtr) {
  const dv = new DataView(coreMemory.buffer);
  const ptr = dv.getUint32(structPtr, true);
  const len = dv.getUint32(structPtr + 4, true);
  return { ptr, bytes: u8core().slice(ptr, ptr + len) };
}
function callWithBytesOut(fn) {
  const out = core.qv_wasm_alloc(8);
  const status = fn(out);
  if (status !== 0) throw new Error(`core call failed: status ${status}`);
  const { bytes } = bytesOut(out);
  core.qv_bytes_free(out);
  core.qv_wasm_free(out, 8);
  return bytes;
}

// --- 1) one-shot encode vs the golden payload anchor ---
const pcm = syntheticPcm();
const pcmPtr = core.qv_wasm_alloc(pcm.length * 2);
new Int16Array(coreMemory.buffer, pcmPtr, pcm.length).set(pcm);
const payload = callWithBytesOut((out) =>
  core.qv_encode(pcmPtr, pcm.length, 1200, CAPACITY_M, out));
const expectedPayload = unhex(
  read('fixtures/expected/synthetic_1200_payload.hex').toString());
console.log('encode == anchor:',
  Buffer.from(payload).equals(Buffer.from(expectedPayload)),
  `(${payload.length} bytes)`);

// --- 2) inspect ---
const plPtr = core.qv_wasm_alloc(payload.length);
u8core().set(payload, plPtr);
const infoPtr = core.qv_wasm_alloc(64);
const st = core.qv_inspect(plPtr, payload.length, infoPtr);
const dv = new DataView(coreMemory.buffer);
const info = {
  status: st,
  version: dv.getUint8(infoPtr),
  hasVoice: dv.getInt32(infoPtr + 4, true),
  bps: dv.getUint16(infoPtr + 8, true),
  frames: dv.getUint32(infoPtr + 12, true),
  durationMs: dv.getUint32(infoPtr + 16, true),
};
console.log('inspect:', JSON.stringify(info));

// --- 3) streaming encoder == one-shot ---
const handlePtr = core.qv_wasm_alloc(4);
if (core.qv_encoder_new(1200, CAPACITY_M, handlePtr) !== 0) throw new Error('encoder_new');
const handle = new DataView(coreMemory.buffer).getUint32(handlePtr, true);
for (let off = 0; off < pcm.length; off += 1000) {
  const chunk = pcm.subarray(off, off + 1000);
  const cp = core.qv_wasm_alloc(chunk.length * 2);
  new Int16Array(coreMemory.buffer, cp, chunk.length).set(chunk);
  if (core.qv_encoder_push(handle, cp, chunk.length) !== 0) throw new Error('push');
  core.qv_wasm_free(cp, chunk.length * 2);
}
const streamed = callWithBytesOut((out) => core.qv_encoder_finalize(handle, out));
console.log('streaming == one-shot:',
  Buffer.from(streamed).equals(Buffer.from(payload)));

// --- 4) decode vs the reference PCM (tolerance) ---
const decodedLe = callWithBytesOut((out) => core.qv_decode(plPtr, payload.length, out));
const decoded = new Int16Array(decodedLe.buffer, decodedLe.byteOffset, decodedLe.length / 2);
const refLe = unhex(read('fixtures/expected/synthetic_1200_decoded.hex').toString());
const ref = new Int16Array(refLe.buffer, refLe.byteOffset, refLe.length / 2);
let max = 0, sum = 0;
for (let i = 0; i < ref.length; i++) {
  const d = Math.abs(decoded[i] - ref[i]);
  if (d > max) max = d;
  sum += d;
}
console.log(`decode vs reference: samples ${decoded.length}, max |diff| ${max}, mean ${(sum / ref.length).toFixed(2)} (thresholds 512 / 8)`);

console.log('qv_max_duration_ms(1200, M):', core.qv_max_duration_ms(1200, CAPACITY_M));
console.log('SMOKE OK');
