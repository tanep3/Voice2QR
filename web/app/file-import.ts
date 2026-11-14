/**
 * Audio-file import: decodeAudioData -> OfflineAudioContext renders it
 * to 8 kHz mono (downmix + resample in one pass) -> Int16Array.
 */
export async function importAudioFile(file: File | Blob): Promise<Int16Array> {
  const bytes = await file.arrayBuffer();
  const decodeCtx = new OfflineAudioContext(1, 1, 8000);
  const decoded = await decodeCtx.decodeAudioData(bytes);

  const frames = Math.max(1, Math.ceil(decoded.duration * 8000));
  const offline = new OfflineAudioContext(1, frames, 8000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const data = rendered.getChannelData(0);
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
  }
  return pcm;
}
