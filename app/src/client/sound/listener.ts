import { getCodec, parseSoundPayload, type SoundDecoder } from './codec';

export type MicState = 'off' | 'starting' | 'ready' | 'denied' | 'unsupported' | 'error';

/**
 * 鬼のスマホが「捕まえた」を長押ししている間、マイクで相手の3桁を聞く。
 *
 * - マイクは、最初に使うとき（ゲーム前の「マイクを使う」か、最初の長押し）に開き、ゲームの段階が終わるまで開けておく。
 *   長押しのたびに開け閉めすると、そのたびに立ち上がりを待つうえ、端末によっては毎回許可を聞かれるため
 * - 音を読むのは長押ししている間だけ。音は手元で読むだけで、どこにも送らない
 * - AudioContext は、タップの直後に一度動かしておかないと、あとで動かせない端末がある（unlock）
 */
export class SoundListener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private decoder: SoundDecoder | null = null;
  private listening = false;
  private onCode: ((code: string) => void) | null = null;
  private opening: Promise<void> | null = null;
  state: MicState = 'off';
  /** 聞こえている音の大きさ（0〜1）。画面の針に使う */
  level = 0;

  /** タップの直後に呼ぶ。AudioContext を作って動かしておく */
  unlock(): void {
    const AC = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    this.ctx ??= new AC();
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** マイクを開く（許可を聞かれるのはここ）。開いたまま、読むのは listen() の間だけ */
  open(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.state = 'unsupported';
      return;
    }
    this.state = 'starting';
    let stream: MediaStream | null = null;
    try {
      // 音の部品を先に読み込む（失敗してもマイクを開けたままにしない）
      const codec = await getCodec();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this.unlock();
      const ctx = this.ctx;
      if (!ctx) {
        stream.getTracks().forEach((t) => t.stop());
        this.state = 'unsupported';
        return;
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      this.decoder?.free();
      this.decoder = codec.decoder(ctx.sampleRate);
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0));
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      this.stream = stream;
      this.source = source;
      this.node = node;
      this.sink = sink;
      this.state = 'ready';
    } catch (e) {
      if (stream && this.stream !== stream) stream.getTracks().forEach((t) => t.stop());
      const name = (e as { name?: string }).name;
      this.state = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error';
    }
  }

  private process(input: Float32Array): void {
    // 針：入ってくる音の大きさ（RMS）を 0〜1 にならす
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    this.level = this.level * 0.6 + Math.min(1, rms * 8) * 0.4;
    if (!this.listening || !this.decoder) return;
    for (const text of this.decoder.push(new Float32Array(input))) {
      const code = parseSoundPayload(text);
      if (code) this.onCode?.(code);
    }
  }

  /** 長押しの押し始めで呼ぶ。マイクがまだなら開いてから読む */
  listen(onCode: (code: string) => void): void {
    this.onCode = onCode;
    this.listening = true;
    if (this.state !== 'ready') void this.open();
  }

  /** 長押しを離したら呼ぶ（マイクは開けたまま） */
  pause(): void {
    this.listening = false;
    this.onCode = null;
  }

  /** ゲームの段階が終わったら呼ぶ。マイクを閉じる */
  close(): void {
    this.pause();
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      // すでに外れている
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.decoder?.free();
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.decoder = null;
    this.level = 0;
    if (this.state === 'ready' || this.state === 'starting') this.state = 'off';
  }

  get isListening(): boolean {
    return this.listening && this.state === 'ready';
  }

  /** 拾ったときの短い「ロックオン」の音（鬼のスマホ） */
  beep(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }
}
