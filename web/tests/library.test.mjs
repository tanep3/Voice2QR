// Library tests against the golden anchors (fixtures/expected/).
// Run with: npm test   (builds first, then node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoice2Qr, Voice2QrError } from '../dist/index.js';
import { fixtureHex, syntheticPcm, renderPixels, pcmDiffStats } from './helpers.mjs';

const anchorPayload = new Uint8Array(
  fixtureHex('fixtures/expected/synthetic_1200_payload.hex'));
const anchorPcmLe = fixtureHex('fixtures/expected/synthetic_1200_decoded.hex');
const anchorPcm = new Int16Array(
  anchorPcmLe.buffer, anchorPcmLe.byteOffset, anchorPcmLe.length / 2);

const v2q = await createVoice2Qr();

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof Voice2QrError, `expected Voice2QrError, got ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected Voice2QrError(${code}), but the call succeeded`);
}

// Regression guard: the library ships as plain ES modules for
// browsers, where bare specifiers ('zxing-wasm/reader') cannot
// resolve. Node tests cannot see that failure — Node resolves bare
// specifiers from node_modules — so scan the built bundles directly.
// (Found live 2026-11-14: the first browser load died on exactly this.)
test('shipped bundles contain no bare module specifiers', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['index.js', 'browser.js']) {
    const src = readFileSync(new URL(`../dist/${f}`, import.meta.url), 'utf8');
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)]
      .map((m) => m[1]);
    const bare = specs.filter(
      (s) =>
        !s.startsWith('./') &&
        !s.startsWith('../') &&
        !s.startsWith('/') &&
        !s.startsWith('node:') &&
        !s.startsWith('data:'),
    );
    assert.deepEqual(bare, [], `${f} has bare specifiers: ${[...new Set(bare)]}`);
  }
});

test('version reports library and format', () => {
  assert.deepEqual(v2q.version, { library: '0.2.0', format: 2 });
});

test('encode matches the golden payload byte for byte', async () => {
  const payload = await v2q.encode(syntheticPcm());
  assert.deepEqual(payload, anchorPayload);
});

test('streaming encoder matches one-shot, with live stats', async () => {
  const pcm = syntheticPcm();
  const enc = v2q.createEncoder();
  for (let off = 0; off < pcm.length; off += 1000) {
    await enc.push(pcm.subarray(off, off + 1000));
  }
  assert.equal(enc.framesEncoded, 25);
  assert.equal(enc.payloadBytes, anchorPayload.length);
  const payload = await enc.finish();
  assert.deepEqual(payload, anchorPayload);
});

// NOTE: this must stay the first *successful* decode in this process —
// libcodec2's process-global PRNG makes later decodes drift in their
// randomized-phase components (see core/tests/golden.rs). Encodes and
// parse-level errors do not consume it.
test('decode matches the reference PCM within tolerance', async () => {
  const pcm = await v2q.decode(anchorPayload);
  assert.equal(pcm.length, anchorPcm.length);
  const { max, mean } = pcmDiffStats(pcm, anchorPcm);
  assert.ok(max <= 512 && mean <= 8, `max ${max}, mean ${mean}`);
});

test('inspect reports the anchor values', async () => {
  const info = await v2q.inspect(anchorPayload);
  assert.equal(info.version, 2);
  assert.deepEqual(info.voice, { bps: 1200, frames: 25, durationMs: 1000 });
  assert.equal(info.hasText, false);
  assert.equal(info.hasImage, false);
});

test('maxDurationMs follows bps and ecLevel capacity', async () => {
  assert.equal(await v2q.maxDurationMs(), 15440);
  assert.equal(await v2q.maxDurationMs({ ecLevel: 'L' }), 19600);
  assert.equal(await v2q.maxDurationMs({ ecLevel: 'H' }), 8400);
});

test('error codes: NOT_QV / NO_VOICE / UNSUPPORTED_BPS / TOO_LARGE', async () => {
  await expectCode(v2q.decode(new Uint8Array([1, 2, 3, 4])), 'NOT_QV');

  // Hand-built QV v2 payload with only a TEXT section ("hi").
  const textOnly = new Uint8Array([
    0x51, 0x56, 0x02, // "QV", version 2
    0x02, 0x02, 0x00, 0x68, 0x69, // TEXT, len 2, "hi"
  ]);
  const info = await v2q.inspect(textOnly);
  assert.equal(info.hasText, true);
  assert.equal(info.voice, undefined);
  await expectCode(v2q.decode(textOnly), 'NO_VOICE');

  await expectCode(v2q.encode(syntheticPcm(), { bps: 1234 }), 'UNSUPPORTED_BPS');

  // 20 s at 1200 bps cannot fit the M capacity.
  const long = new Int16Array(160000);
  await expectCode(v2q.encode(long), 'TOO_LARGE');
});

test('payloadToQr produces the expected matrix shape', async () => {
  const qr = await v2q.payloadToQr(anchorPayload);
  assert.equal(qr.version, 9);
  assert.equal(qr.size, 53);
  assert.equal(qr.modules.length, 53 * 53);
  assert.equal(qr.ecLevel, 'M');
});

test('QR round trip: matrix -> pixels -> payload', async () => {
  const qr = await v2q.payloadToQr(anchorPayload);
  const pixels = renderPixels(qr);
  const back = await v2q.qrToPayload(pixels);
  assert.deepEqual(back, anchorPayload);
});

test('readQr reports the symbol ec level at every level', async () => {
  for (const ecLevel of ['L', 'M', 'Q', 'H']) {
    const qr = await v2q.payloadToQr(anchorPayload, { ecLevel });
    const result = await v2q.readQr(renderPixels(qr));
    assert.deepEqual(result.payload, anchorPayload);
    assert.equal(result.ecLevel, qr.ecLevel);
    // Rescue invariant: re-encoding the read payload at the reported
    // level reproduces the very same symbol, module for module.
    const copy = await v2q.payloadToQr(result.payload, {
      ecLevel: result.ecLevel,
    });
    assert.deepEqual(copy.modules, qr.modules);
  }
});

test('qrToPayload on a blank image is QR_NOT_FOUND', async () => {
  const blank = {
    data: new Uint8ClampedArray(200 * 200 * 4).fill(255),
    width: 200,
    height: 200,
  };
  await expectCode(v2q.qrToPayload(blank), 'QR_NOT_FOUND');
});

test('payloadToQr beyond QR capacity is QR_TOO_LARGE', async () => {
  await expectCode(
    v2q.payloadToQr(new Uint8Array(3000), { ecLevel: 'L' }),
    'QR_TOO_LARGE',
  );
});

test('printLayout picks the largest whole pixels-per-module that fits', async () => {
  const { printLayout } = await import('../dist/browser.js');
  // Standard case: 145 modules incl. quiet zone.
  assert.deepEqual(printLayout(145, 384), { modulePx: 2, offsetPx: 47, canvasPx: 384 });
  assert.deepEqual(printLayout(145, 576), { modulePx: 3, offsetPx: 70, canvasPx: 576 });
  // Longest recording: 185 modules. T02 width fits 2 px/module with
  // only 14 px to spare; M02S width fits 3 px/module.
  assert.deepEqual(printLayout(185, 384), { modulePx: 2, offsetPx: 7, canvasPx: 384 });
  assert.deepEqual(printLayout(185, 576), { modulePx: 3, offsetPx: 10, canvasPx: 576 });
  // The QR plus its quiet zone always stays inside the canvas.
  for (const [total, width] of [[145, 384], [145, 576], [185, 384], [185, 576], [25, 384]]) {
    const l = printLayout(total, width);
    assert.ok(l.modulePx >= 1);
    assert.ok(l.offsetPx >= 0 && l.offsetPx + total * l.modulePx <= width);
  }
});
