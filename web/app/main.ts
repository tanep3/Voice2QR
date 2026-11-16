/**
 * Voice2QR web app (docs/system-design.md §2). The app is a *user* of
 * the published JS library: it does NOT bundle it — at startup it
 * imports the co-located library (site/lib/v1/) by relative URL, so
 * self-contained deployments carry their own copy. A fallback to the
 * workspace build (../dist/) keeps `vite dev` usable.
 *
 * Session data (PCM, payloads) lives in memory only and is dropped
 * when a new session starts — recordings are never retained.
 */
import type * as Lib from '../lib/index.js';
import type * as LibBrowser from '../lib/browser.js';

/** Build-time constant injected by vite.config.ts (package.json "appVersion"). */
declare const __APP_VERSION__: string;
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { applyI18n, setLang, t, type Lang } from './i18n.js';
import { Recorder } from './recorder.js';
import { importAudioFile } from './file-import.js';
import { Player } from './player.js';
import { printQrImage } from './print.js';

const CAPACITY: Record<Settings['ecLevel'], number> = {
  L: 2953,
  M: 2331,
  Q: 1663,
  H: 1273,
};

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

async function loadLibrary(): Promise<{
  lib: typeof Lib;
  browser: typeof LibBrowser;
}> {
  // One load path in dev and production alike (vite.config.ts serves
  // web/dist/ at /lib/v1/ in dev; assemble-site.mjs copies it in build).
  const base = document.baseURI;
  const lib = (await import(
    /* @vite-ignore */ new URL('lib/v1/index.js', base).href
  )) as typeof Lib;
  const browser = (await import(
    /* @vite-ignore */ new URL('lib/v1/browser.js', base).href
  )) as typeof LibBrowser;
  return { lib, browser };
}

async function main(): Promise<void> {
  const settings = loadSettings();
  setLang(settings.lang);
  document.documentElement.lang = settings.lang;
  applyI18n();

  const { lib, browser } = await loadLibrary();
  const v2q = await lib.createVoice2Qr();

  // ----- settings UI -----
  const selLang = $<HTMLSelectElement>('sel-lang');
  const selBps = $<HTMLSelectElement>('sel-bps');
  const selEc = $<HTMLSelectElement>('sel-ec');
  selLang.value = settings.lang;
  selBps.value = String(settings.bps);
  selEc.value = settings.ecLevel;
  selLang.addEventListener('change', () => {
    settings.lang = selLang.value as Lang;
    saveSettings(settings);
    setLang(settings.lang);
    document.documentElement.lang = settings.lang;
    applyI18n();
    refreshRecordButton();
  });
  selBps.addEventListener('change', () => {
    settings.bps = Number(selBps.value);
    saveSettings(settings);
  });
  selEc.addEventListener('change', () => {
    settings.ecLevel = selEc.value as Settings['ecLevel'];
    saveSettings(settings);
  });

  // ----- tabs -----
  const tabCreate = $<HTMLButtonElement>('tab-create');
  const tabRead = $<HTMLButtonElement>('tab-read');
  const viewCreate = $<HTMLElement>('view-create');
  const viewRead = $<HTMLElement>('view-read');
  const showView = (create: boolean) => {
    tabCreate.classList.toggle('active', create);
    tabRead.classList.toggle('active', !create);
    viewCreate.classList.toggle('active', create);
    viewRead.classList.toggle('active', !create);
    if (create) void stopCamera();
  };
  tabCreate.addEventListener('click', () => showView(true));
  tabRead.addEventListener('click', () => showView(false));

  // ----- shared player -----
  const player = new Player();

  // =====================================================================
  // Create view
  // =====================================================================
  const btnRecord = $<HTMLButtonElement>('btn-record');
  const recStatus = $<HTMLElement>('rec-status');
  const recProgress = $<HTMLProgressElement>('rec-progress');
  const createResult = $<HTMLElement>('create-result');
  const createError = $<HTMLElement>('create-error');
  const qrCanvas = $<HTMLCanvasElement>('qr');
  const resultInfo = $<HTMLElement>('result-info');

  const recorder = new Recorder();
  let encoder: Lib.Encoder | null = null;
  let currentPayload: Uint8Array | null = null;
  let maxDurationMs = 0;
  let capacity = CAPACITY[settings.ecLevel];

  // Recording pipeline: worklet chunks land in a queue; ONE drain loop
  // pushes them into the encoder in order. Stops (manual or capacity)
  // only set a flag — finalization happens in the drain loop, never
  // inside a queued step. (An earlier chain-based version deadlocked:
  // the capacity auto-stop awaited the very promise chain it was part
  // of, freezing the UI with no QR — hit at high bps, where capacity
  // arrives before a manual stop.)
  let pcmQueue: Int16Array[] = [];
  let draining = false;
  let stopRequested: 'manual' | 'capacity' | null = null;
  let finalizeStarted = false;

  function refreshRecordButton(): void {
    btnRecord.textContent = recorder.recording ? t('stop') : t('record');
    btnRecord.classList.toggle('recording', recorder.recording);
  }

  // During field debugging the error area shows the raw error code
  // (e.g. "Error: TOO_LARGE") instead of a generic sentence — a
  // generic message cost us a full round-trip on 2026-11-14.
  function describeError(e: unknown): string {
    if (e instanceof lib.Voice2QrError) return `Error: ${e.code} — ${e.message}`;
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  function showPayload(payload: Uint8Array): void {
    currentPayload = payload;
    createResult.hidden = false;
    createError.textContent = '';
    void (async () => {
      try {
        const matrix = await v2q.payloadToQr(payload, { ecLevel: settings.ecLevel });
        browser.drawQr(qrCanvas, matrix, { modulePx: 6 });
        const info = await v2q.inspect(payload);
        const sec = info.voice ? (info.voice.durationMs / 1000).toFixed(1) : '0';
        resultInfo.textContent = t('resultInfo', { sec, bytes: payload.length });
      } catch (e) {
        createError.textContent = describeError(e);
      }
    })();
  }

  async function finalizeRecording(): Promise<void> {
    if (finalizeStarted || !encoder) return;
    finalizeStarted = true;
    const enc = encoder;
    const capacityFull = stopRequested === 'capacity';
    encoder = null;
    pcmQueue = [];
    try {
      await recorder.stop();
    } catch {
      // A failing recorder teardown must not eat the recording.
    }
    refreshRecordButton();
    try {
      const payload = await enc.finish();
      recStatus.textContent = capacityFull ? t('capacityFull') : '';
      showPayload(payload);
    } catch (e) {
      createError.textContent = describeError(e);
    }
  }

  function requestStop(kind: 'manual' | 'capacity'): void {
    if (!stopRequested) stopRequested = kind;
    void recorder.stop();
    refreshRecordButton();
    void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (encoder && !stopRequested && pcmQueue.length > 0) {
        const chunk = pcmQueue.shift()!;
        const enc = encoder;
        try {
          await enc.push(chunk);
        } catch (e) {
          if (e instanceof lib.Voice2QrError && e.code === 'TOO_LARGE') {
            stopRequested = 'capacity';
          } else {
            createError.textContent = describeError(e);
            stopRequested = 'manual';
          }
          break;
        }
        const frac = Math.min(1, enc.payloadBytes / capacity);
        recProgress.value = frac * 100;
        const remainS = Math.max(
          0,
          (maxDurationMs / 1000) * (1 - frac),
        ).toFixed(0);
        recStatus.textContent = `${t('recording')} ${t('remaining', { s: remainS })}`;
        if (enc.payloadBytes >= capacity) stopRequested = 'capacity';
      }
    } finally {
      draining = false;
    }
    if (stopRequested) {
      await recorder.stop();
      refreshRecordButton();
      await finalizeRecording();
    }
  }

  async function toggleRecord(): Promise<void> {
    if (recorder.recording || encoder) {
      requestStop('manual');
      return;
    }
    createError.textContent = '';
    createResult.hidden = true;
    currentPayload = null;
    stopRequested = null;
    finalizeStarted = false;
    pcmQueue = [];
    try {
      capacity = CAPACITY[settings.ecLevel];
      maxDurationMs = await v2q.maxDurationMs({
        bps: settings.bps,
        ecLevel: settings.ecLevel,
      });
      encoder = v2q.createEncoder({ bps: settings.bps, ecLevel: settings.ecLevel });
      const enc = encoder;
      await recorder.start((chunk) => {
        if (encoder !== enc || stopRequested) return;
        pcmQueue.push(chunk);
        void drainQueue();
      });
      recProgress.value = 0;
      recStatus.textContent = t('recording');
      refreshRecordButton();
    } catch {
      encoder = null;
      createError.textContent = t('micError');
    }
  }
  btnRecord.addEventListener('click', () => void toggleRecord());

  $<HTMLInputElement>('file-audio').addEventListener('change', async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    createError.textContent = '';
    recStatus.textContent = t('processing');
    try {
      const pcm = await importAudioFile(file);
      // A file longer than the QR capacity is trimmed to the first
      // maxDuration, with a notice — the alternative (a bare error)
      // leaves the user with no QR at all. (Judgment call, 2026-11-14.)
      const maxMs = await v2q.maxDurationMs({
        bps: settings.bps,
        ecLevel: settings.ecLevel,
      });
      const maxSamples = Math.floor((maxMs / 1000) * 8000);
      const trimmed = pcm.length > maxSamples;
      const used = trimmed ? pcm.subarray(0, maxSamples) : pcm;
      const payload = await v2q.encode(used, {
        bps: settings.bps,
        ecLevel: settings.ecLevel,
      });
      recStatus.textContent = trimmed
        ? t('trimmed', { sec: (maxMs / 1000).toFixed(1) })
        : '';
      showPayload(payload);
    } catch {
      recStatus.textContent = '';
      createError.textContent = t('fileError');
    }
  });

  $<HTMLButtonElement>('btn-save').addEventListener('click', async () => {
    if (!currentPayload) return;
    const blob = await browser.payloadToPng(currentPayload, {
      ecLevel: settings.ecLevel,
      modulePx: 10,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voice2qr.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  $<HTMLButtonElement>('btn-print').addEventListener('click', async () => {
    if (!currentPayload) return;
    const blob = await browser.payloadToPng(currentPayload, {
      ecLevel: settings.ecLevel,
      modulePx: 20,
    });
    const url = URL.createObjectURL(blob);
    printQrImage(url);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  // ----- share (Web Share API → share sheet, e.g. to the Phomemo app) --
  // Same route as MiniMapPrint: share the PNG file; browsers without
  // file sharing get a hint to use Save PNG instead.
  async function shareQr(): Promise<void> {
    if (!currentPayload) return;
    try {
      const blob = await browser.payloadToPng(currentPayload, {
        ecLevel: settings.ecLevel,
        modulePx: 10,
      });
      const file = new File([blob], 'voice2qr.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        createError.textContent = t('shareUnsupported');
      }
    } catch (e) {
      // Dismissing the share sheet is not an error.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      createError.textContent = describeError(e);
    }
  }
  $<HTMLButtonElement>('btn-share').addEventListener('click', () => void shareQr());
  $<HTMLButtonElement>('btn-modal-share').addEventListener('click', () => void shareQr());

  // ----- enlarged QR (tap the QR) -----
  const qrModal = $<HTMLElement>('qr-modal');
  const qrBig = $<HTMLCanvasElement>('qr-big');
  function closeModal(): void {
    qrModal.hidden = true;
    document.body.style.overflow = '';
  }
  qrCanvas.addEventListener('click', async () => {
    if (!currentPayload) return;
    try {
      const matrix = await v2q.payloadToQr(currentPayload, {
        ecLevel: settings.ecLevel,
      });
      browser.drawQr(qrBig, matrix, { modulePx: 10 });
      qrModal.hidden = false;
      document.body.style.overflow = 'hidden';
    } catch (e) {
      createError.textContent = describeError(e);
    }
  });
  $<HTMLButtonElement>('btn-modal-close').addEventListener('click', closeModal);
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !qrModal.hidden) closeModal();
  });

  const btnPreview = $<HTMLButtonElement>('btn-preview');
  btnPreview.addEventListener('click', async () => {
    if (!currentPayload) return;
    if (player.playing) {
      player.stop();
      btnPreview.textContent = t('play');
      return;
    }
    // Playback preview decodes the payload itself (never pre-encode PCM).
    const pcm = await v2q.decode(currentPayload);
    btnPreview.textContent = t('stopPlay');
    await player.play(pcm);
  });
  player.onended = () => {
    btnPreview.textContent = t('play');
    btnPlay.textContent = t('play');
  };

  // =====================================================================
  // Read view
  // =====================================================================
  const readStatus = $<HTMLElement>('read-status');
  const readError = $<HTMLElement>('read-error');
  const readResult = $<HTMLElement>('read-result');
  const readInfo = $<HTMLElement>('read-info');
  const btnPlay = $<HTMLButtonElement>('btn-play');
  const btnCamera = $<HTMLButtonElement>('btn-camera');
  const video = $<HTMLVideoElement>('camera');
  let readPayload: Uint8Array | null = null;
  let cameraStream: MediaStream | null = null;
  let cameraTimer: number | null = null;
  let cameraScanStart = 0;
  let cameraLastLadder = 0;

  async function acceptPayload(payload: Uint8Array): Promise<void> {
    readError.textContent = '';
    try {
      const info = await v2q.inspect(payload);
      if (info.voice) {
        readPayload = payload;
        readResult.hidden = false;
        readInfo.textContent = t('voiceFound', {
          sec: (info.voice.durationMs / 1000).toFixed(1),
          bps: info.voice.bps,
        });
      } else {
        readPayload = null;
        readResult.hidden = true;
        readError.textContent = t('noVoice');
      }
    } catch {
      readPayload = null;
      readResult.hidden = true;
      readError.textContent = t('readError');
    }
  }

  // ----- image intake: every route normalizes to a Blob -----
  // File picker, drag & drop, clipboard paste, and the share target
  // all end here, so every route gets the same decode + retry path.
  async function acceptImageBlob(blob: Blob): Promise<void> {
    readError.textContent = '';
    try {
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const payload = await v2q.qrToPayload(
        {
          data: imageData.data,
          width: imageData.width,
          height: imageData.height,
        },
        { scaleRetry: true },
      );
      await acceptPayload(payload);
    } catch {
      readPayload = null;
      readResult.hidden = true;
      readError.textContent = t('readError');
    }
  }

  const fileImage = $<HTMLInputElement>('file-image');
  const dropZone = $<HTMLElement>('drop-zone');
  dropZone.addEventListener('click', () => fileImage.click());
  dropZone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      fileImage.click();
    }
  });
  fileImage.addEventListener('change', () => {
    const file = fileImage.files?.[0];
    fileImage.value = '';
    if (file) void acceptImageBlob(file);
  });
  dropZone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropZone.classList.remove('dragover');
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      readError.textContent = t('readError');
      return;
    }
    void acceptImageBlob(file);
  });

  // Clipboard: ONE route, the paste event. The Async Clipboard API
  // (clipboard.read) was dropped: its image surface is effectively
  // PNG-only, so a copy another app placed as a JPEG never reaches
  // it (seen on iPad with an image copied from X). The paste event
  // goes through the browser's legacy paste path, which tolerates
  // JPEG and other formats. On touch devices the callout menu needs
  // an editable target — the paste box (placeholder: Paste). A page
  // cannot paste programmatically, so the flow is tap the box,
  // then Paste in the callout; on PC, Ctrl+V anywhere in this view
  // works too.
  const pasteBox = $<HTMLElement>('paste-box');
  document.addEventListener('paste', (ev) => {
    if (!viewRead.classList.contains('active')) return;
    const data = ev.clipboardData;
    if (!data) return;
    let file: File | null = data.files?.[0] ?? null;
    if (file && !file.type.startsWith('image/')) file = null;
    if (!file) {
      for (const item of data.items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          file = item.getAsFile();
          if (file) break;
        }
      }
    }
    if (file) {
      ev.preventDefault();
      void acceptImageBlob(file);
    }
    // The paste box is a drop target for the event, not an editor:
    // clear anything the browser inserted into it.
    if (ev.target instanceof Node && pasteBox.contains(ev.target)) {
      window.setTimeout(() => {
        pasteBox.innerHTML = '';
      }, 0);
    }
  });

  // ----- share-target intake -----
  // The service worker stashes an image shared from another app in
  // the share cache and redirects here with ?share=<uuid>. Consume
  // it once, then sweep leftovers older than the TTL — a fresh entry
  // may belong to another tab that has not consumed it yet, so the
  // sweep must not simply delete everything else.
  const SHARE_CACHE = 'voice2qr-share';
  const SHARE_TTL_MS = 10 * 60 * 1000;
  async function consumeSharedImage(): Promise<void> {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(SHARE_CACHE);
      const params = new URLSearchParams(window.location.search);
      const id = params.get('share');
      if (id) {
        const key = new URL(`shared-image/${id}`, document.baseURI).href;
        const hit = await cache.match(key);
        if (hit) {
          await cache.delete(key);
          showView(false);
          await acceptImageBlob(await hit.blob());
        }
        params.delete('share');
        const qs = params.toString();
        window.history.replaceState(
          null,
          '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
        );
      }
      for (const key of await cache.keys()) {
        const res = await cache.match(key);
        const savedAt = Number(res?.headers.get('x-v2q-saved-at') ?? 0);
        if (!savedAt || Date.now() - savedAt > SHARE_TTL_MS) {
          await cache.delete(key);
        }
      }
    } catch {
      // No Cache Storage (or nothing shared): nothing to consume.
    }
  }
  void consumeSharedImage();

  async function stopCamera(): Promise<void> {
    if (cameraTimer !== null) {
      window.clearInterval(cameraTimer);
      cameraTimer = null;
    }
    cameraStream?.getTracks().forEach((tr) => tr.stop());
    cameraStream = null;
    video.hidden = true;
    btnCamera.textContent = t('cameraStart');
    if (readStatus.textContent === t('scanning')) readStatus.textContent = '';
  }

  btnCamera.addEventListener('click', async () => {
    if (cameraStream) {
      await stopCamera();
      return;
    }
    readError.textContent = '';
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          // Ask for the best resolution the camera has: dense QR codes
          // (100+ modules) are starved for pixels on a 640x480 default.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch {
      readError.textContent = t('readError');
      return;
    }
    video.srcObject = cameraStream;
    video.hidden = false;
    btnCamera.textContent = t('cameraStop');
    readStatus.textContent = t('scanning');
    cameraScanStart = Date.now();
    cameraLastLadder = 0;
    const canvas = document.createElement('canvas');
    cameraTimer = window.setInterval(() => {
      if (!cameraStream || video.videoWidth === 0) return;
      // Keep frames near-native (cap 1920 wide): downscaling a dense
      // QR destroys the modules the reader needs.
      const scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Live reads run on fresh frames at the normal cadence. When a
      // scan has failed continuously for a few seconds (a static setup,
      // e.g. a low-resolution PC camera facing a print, where the
      // presentation scale never changes on its own), spend one tick on
      // the scale-ladder retry, at most once every few seconds, so the
      // live cadence is not disturbed.
      const now = Date.now();
      const useLadder =
        now - cameraScanStart > 3000 && now - cameraLastLadder > 3000;
      if (useLadder) cameraLastLadder = now;
      void v2q
        .qrToPayload(
          {
            data: imageData.data,
            width: imageData.width,
            height: imageData.height,
          },
          { scaleRetry: useLadder },
        )
        .then(async (payload) => {
          await stopCamera();
          await acceptPayload(payload);
        })
        .catch(() => {
          // QR_NOT_FOUND: keep scanning.
        });
    }, 300);
  });

  btnPlay.addEventListener('click', async () => {
    if (!readPayload) return;
    if (player.playing) {
      player.stop();
      btnPlay.textContent = t('play');
      return;
    }
    try {
      const pcm = await v2q.decode(readPayload);
      btnPlay.textContent = t('stopPlay');
      await player.play(pcm);
    } catch {
      readError.textContent = t('readError');
    }
  });

  // ----- PWA: cache code assets only (never data) -----
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {
      // Not a secure context or no SW support: the app still works.
    }
  }
  void checkForUpdate();
}

/**
 * Static hosting cannot push updates, and a cache-first service worker
 * would happily serve the previous release forever. So the running app
 * probes the site's version.json (never cached, never intercepted by
 * the worker): if the deployed version differs from this build's, a
 * newer release exists — drop this app's caches, unregister the
 * worker, and reload once to pick it up. The sessionStorage marker
 * prevents a reload loop if the fresh load still reports a mismatch.
 */
async function checkForUpdate(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update().catch(() => undefined);
    const response = await fetch('./version.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = (await response.json()) as { version?: string };
    if (!data.version || data.version === __APP_VERSION__) return;
    if (sessionStorage.getItem('v2q-reloaded-for') === data.version) return;
    sessionStorage.setItem('v2q-reloaded-for', data.version);
    if ('caches' in window) {
      // Cache Storage is shared by the whole origin: delete only this
      // app's own caches (same prefix rule as the worker's activate).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('voice2qr-') && k !== 'voice2qr-share')
          .map((k) => caches.delete(k)),
      );
    }
    await registration?.unregister().catch(() => undefined);
    window.location.reload();
  } catch {
    // Offline, or no version.json (dev server): nothing to update to.
  }
}

main().catch((e: unknown) => {
  console.error(e);
  const el = document.getElementById('create-error');
  if (el) el.textContent = t('loading') + ' — ' + (e instanceof Error ? e.message : String(e));
});
