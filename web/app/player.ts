/**
 * Playback of decoded PCM (8 kHz mono Int16). The AudioBuffer carries
 * sampleRate 8000; the context resamples to the device rate itself.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  onended: (() => void) | null = null;

  get playing(): boolean {
    return this.source !== null;
  }

  async play(pcm: Int16Array): Promise<void> {
    this.stop();
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    const buffer = this.ctx.createBuffer(1, pcm.length, 8000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.onended?.();
      }
    };
    this.source = source;
    source.start();
  }

  stop(): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      s.onended = null;
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
  }
}
