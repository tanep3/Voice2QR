/**
 * Microphone recording: getUserMedia -> AudioWorklet (device rate ->
 * 8 kHz mono Int16) -> PCM chunks out through a callback.
 * The recorder knows nothing about encoding; main.ts feeds the chunks
 * to the library's streaming Encoder.
 */
export type PcmHandler = (chunk: Int16Array) => void;

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  get recording(): boolean {
    return this.ctx !== null;
  }

  async start(onPcm: PcmHandler): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
    });
    this.ctx = new AudioContext();
    // worklet.js is a verbatim public asset (site root), referenced
    // relative to the page — AudioWorklet refuses data: URLs, so it
    // must not go through the bundler's asset inlining.
    await this.ctx.audioWorklet.addModule(
      new URL('worklet.js', document.baseURI).href,
    );
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'voice2qr-recorder');
    this.node.port.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === 'pcm') onPcm(ev.data.samples as Int16Array);
    };
    source.connect(this.node);
    // The worklet has no output; connect through a muted gain so the
    // graph pulls it in every browser.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.node = null;
      await ctx.close();
    }
  }
}
