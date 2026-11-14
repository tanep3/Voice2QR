/**
 * AudioWorklet processor: converts the device-rate mono input to
 * 8 kHz mono Int16 chunks and posts them to the main thread.
 *
 * Resampling is a windowed-sinc (Blackman) filter bank computed on the
 * fly: for each output sample, sum the input samples around the
 * corresponding input position with sinc weights cut off at the lower
 * of the two Nyquist rates. Plain JS on purpose: this file is a
 * verbatim public asset (AudioWorklet cannot load bundled/data URLs).
 */
class Resampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate; // input samples per output sample
    // Filter half-length in input samples: 8 output periods' worth.
    this.half = Math.ceil(8 * this.ratio);
    // Cutoff (cycles per input sample): min(input, output) Nyquist.
    this.fc = 0.5 / Math.max(1, this.ratio);
    this.buf = []; // pending input samples (float)
    this.pos = 0; // fractional read position within buf
  }

  /** Feed input samples; return an Int16Array of output samples. */
  push(input) {
    for (let i = 0; i < input.length; i++) this.buf.push(input[i]);
    const out = [];
    for (;;) {
      const center = this.pos + this.half;
      if (center + this.half >= this.buf.length) break;
      let sum = 0;
      let wsum = 0;
      const i0 = Math.floor(center) - this.half;
      for (let i = i0; i <= Math.floor(center) + this.half; i++) {
        const d = i - center;
        const x = d * this.fc * 2; // in units of the cutoff period
        // sinc(x) = sin(pi x) / (pi x)
        let w = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Blackman window over the kernel span.
        const u = d / (2 * this.half) + 0.5;
        w *= 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
        sum += this.buf[i] * w;
        wsum += w;
      }
      const v = wsum !== 0 ? sum / wsum : 0;
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
      this.pos += this.ratio;
    }
    // Drop consumed input (keep the window overlap).
    const drop = Math.floor(this.pos) - this.half;
    if (drop > 0) {
      this.buf.splice(0, drop);
      this.pos -= drop;
    }
    return Int16Array.from(out);
  }
}

class Voice2QrRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate, 8000);
    this.pending = [];
    this.pendingLen = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const out = this.resampler.push(ch);
      if (out.length) {
        this.pending.push(out);
        this.pendingLen += out.length;
        // Emit in ~40 ms chunks (320 samples at 8 kHz).
        while (this.pendingLen >= 320) {
          const merged = new Int16Array(this.pendingLen);
          let off = 0;
          for (const p of this.pending) {
            merged.set(p, off);
            off += p.length;
          }
          const chunk = merged.subarray(0, 320);
          this.port.postMessage({ type: 'pcm', samples: chunk }, []);
          const rest = merged.subarray(320);
          this.pending = rest.length ? [Int16Array.from(rest)] : [];
          this.pendingLen = rest.length;
        }
      }
    }
    return true;
  }
}

registerProcessor('voice2qr-recorder', Voice2QrRecorder);
