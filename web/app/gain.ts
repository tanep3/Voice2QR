/**
 * Whole-clip peak normalization, applied to a recording before it is
 * encoded (app-level pre-processing; the library never touches levels).
 *
 * One fixed gain for the whole clip, chosen from its loudest sample:
 * voice and room noise scale by the same factor, so the SNR is
 * unchanged and no new noise appears — unlike a live AGC, pauses are
 * not gained up more than speech, so there is no pumping and no
 * noise-floor creep. A quiet recording simply plays back louder.
 */

/** ≈ -1 dBFS: as loud as possible without clipping the codec input. */
const TARGET_PEAK = 29136;
/** +30 dB cap: near-silence must not be blown up into amplified hiss. */
const MAX_GAIN = 32;

export function normalizePcm(pcm: Int16Array): Int16Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > peak) peak = a;
  }
  const out = new Int16Array(pcm.length);
  if (peak === 0) {
    out.set(pcm);
    return out;
  }
  const gain = Math.min(TARGET_PEAK / peak, MAX_GAIN);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.round(pcm[i] * gain);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}
