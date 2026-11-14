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
  let pushChain: Promise<void> = Promise.resolve();
  let currentPayload: Uint8Array | null = null;
  let maxDurationMs = 0;
  let capacity = CAPACITY[settings.ecLevel];

  function refreshRecordButton(): void {
    btnRecord.textContent = recorder.recording ? t('stop') : t('record');
  }

  function showPayload(payload: Uint8Array): void {
    currentPayload = payload;
    createResult.hidden = false;
    createError.textContent = '';
    void (async () => {
      const matrix = await v2q.payloadToQr(payload, { ecLevel: settings.ecLevel });
      browser.drawQr(qrCanvas, matrix, { modulePx: 6 });
      const info = await v2q.inspect(payload);
      const sec = info.voice ? (info.voice.durationMs / 1000).toFixed(1) : '0';
      resultInfo.textContent = t('resultInfo', { sec, bytes: payload.length });
    })();
  }

  async function finishRecording(capacityFull: boolean): Promise<void> {
    if (!encoder) return;
    const enc = encoder;
    encoder = null;
    await recorder.stop();
    refreshRecordButton();
    await pushChain;
    try {
      const payload = await enc.finish();
      recStatus.textContent = capacityFull ? t('capacityFull') : '';
      showPayload(payload);
    } catch {
      createError.textContent = t('fileError');
    }
  }

  async function toggleRecord(): Promise<void> {
    if (recorder.recording) {
      await finishRecording(false);
      return;
    }
    createError.textContent = '';
    createResult.hidden = true;
    currentPayload = null;
    try {
      capacity = CAPACITY[settings.ecLevel];
      maxDurationMs = await v2q.maxDurationMs({
        bps: settings.bps,
        ecLevel: settings.ecLevel,
      });
      encoder = v2q.createEncoder({ bps: settings.bps, ecLevel: settings.ecLevel });
      pushChain = Promise.resolve();
      const enc = encoder;
      await recorder.start((chunk) => {
        if (encoder !== enc) return;
        pushChain = pushChain.then(async () => {
          if (encoder !== enc) return;
          try {
            await enc.push(chunk);
          } catch (e) {
            if (e instanceof lib.Voice2QrError && e.code === 'TOO_LARGE') {
              await finishRecording(true);
            }
            return;
          }
          const frac = Math.min(1, enc.payloadBytes / capacity);
          recProgress.value = frac * 100;
          const remainS = Math.max(
            0,
            (maxDurationMs / 1000) * (1 - frac),
          ).toFixed(0);
          recStatus.textContent = `${t('recording')} ${t('remaining', { s: remainS })}`;
          if (enc.payloadBytes >= capacity) {
            await finishRecording(true);
          }
        });
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
      const payload = await v2q.encode(pcm, {
        bps: settings.bps,
        ecLevel: settings.ecLevel,
      });
      recStatus.textContent = '';
      showPayload(payload);
    } catch (e) {
      recStatus.textContent = '';
      createError.textContent =
        e instanceof lib.Voice2QrError && e.code === 'TOO_LARGE'
          ? t('capacityFull')
          : t('fileError');
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

  $<HTMLInputElement>('file-image').addEventListener('change', async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    readError.textContent = '';
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const payload = await v2q.qrToPayload({
        data: imageData.data,
        width: imageData.width,
        height: imageData.height,
      });
      await acceptPayload(payload);
    } catch {
      readPayload = null;
      readResult.hidden = true;
      readError.textContent = t('readError');
    }
  });

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
        video: { facingMode: 'environment' },
      });
    } catch {
      readError.textContent = t('readError');
      return;
    }
    video.srcObject = cameraStream;
    video.hidden = false;
    btnCamera.textContent = t('cameraStop');
    readStatus.textContent = t('scanning');
    const canvas = document.createElement('canvas');
    cameraTimer = window.setInterval(() => {
      if (!cameraStream || video.videoWidth === 0) return;
      const scale = Math.min(1, 800 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      void v2q
        .qrToPayload({
          data: imageData.data,
          width: imageData.width,
          height: imageData.height,
        })
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
}

main().catch((e: unknown) => {
  console.error(e);
  const el = document.getElementById('create-error');
  if (el) el.textContent = t('loading') + ' — ' + (e instanceof Error ? e.message : String(e));
});
