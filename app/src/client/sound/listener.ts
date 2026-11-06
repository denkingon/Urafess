import { getCodec, parseSoundPayload, type SoundDecoder } from './codec';

export type MicState = 'off' | 'starting' | 'ready' | 'denied' | 'unsupported' | 'error';

/** 音の試し（/lab）で見る、マイクの様子。どちらのスマホが弱いかを切り分けるため */
export interface MicProbe {
  /** 音の処理の速さ（Hz）。超音波（15kHz より上）を拾うには 40000 以上が要る */
  rate: number;
  /** マイク側が名乗る取り込みの速さ（Hz。分からなければ null） */
  trackRate: number | null;
  /** マイクの名前（AirPods などに切り替わっていないか） */
  label: string;
  /** エコー消しが入っているか（分からなければ null） */
  echo: boolean | null;
  /** 聞こえる帯（1〜7kHz。3音のフレーズが入る所）のいちばん強い所（dB） */
  audibleDb: number;
  /** 超音波の帯（15〜20kHz。番号が入る所）のいちばん強い所（dB） */
  ultraDb: number;
}

/** 超音波を拾えない取り込み・マイクか（拾えないなら理由の短い言葉、拾えそうなら null） */
export function micLimit(p: Pick<MicProbe, 'rate' | 'trackRate' | 'label'>): string | null {
  const rate = Math.min(p.rate, p.trackRate ?? p.rate);
  if (rate < 40_000) return `取り込みが ${rate}Hz なので、超音波は拾えない`;
  if (/airpods|bluetooth|headset|hands-?free|buds|beats|イヤホン|ヘッドセット/i.test(p.label)) return `マイクが「${p.label}」になっている`;
  return null;
}

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
  /** 音の試しで帯ごとの大きさを見るときだけ作る（試合では作らない） */
  private analyser: AnalyserNode | null = null;
  private spectrum: Float32Array<ArrayBuffer> | null = null;
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
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AC();
    // iPhone は電話や別の音で止めると 'interrupted' になる。'suspended' と同じく、タップの直後に動かし直す
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
  }

  /**
   * マイクが本当に音を拾える状態か。開けたあとでも、iPhone では画面を離れる・ほかの音のアプリ・電話などで
   * マイクが止まったり（track が ended・muted）、音の処理が止まったり（AudioContext が suspended・interrupted）する。
   * 画面はこれで「マイクをオンにする」を出し続けるかを決める
   */
  get live(): boolean {
    if (this.state !== 'ready') return false;
    const track = this.stream?.getAudioTracks()[0];
    return !!track && track.readyState === 'live' && !track.muted && this.ctx?.state === 'running';
  }

  /** マイクを開く（許可を聞かれるのはここ）。開いたまま、読むのは listen() の間だけ */
  open(): Promise<void> {
    if (this.live) return Promise.resolve();
    if (this.state === 'ready') {
      const track = this.stream?.getAudioTracks()[0];
      if (track && track.readyState === 'live' && !track.muted) {
        // マイクは生きていて、音の処理だけ止まっている：動かし直すだけでよい（このタップの中で）
        this.unlock();
        return Promise.resolve();
      }
      // マイクが止まった：閉じて、開き直す
      this.close();
    }
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
      // 止まったら（ほかのアプリがマイクを取った・端末が切った）閉じて、画面に「もう一度オンにする」を出させる
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (this.stream === stream) this.close();
        });
      }
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

  /**
   * 音の試し（/lab）用：いまマイクに入っている音を、聞こえる帯と超音波の帯に分けて見る。
   * 相手が鳴らしている間に聞こえる帯だけ上がって超音波の帯が上がらなければ、超音波が途中で消えている
   */
  probe(): MicProbe | null {
    const ctx = this.ctx;
    const source = this.source;
    if (!ctx || !source || this.state !== 'ready') return null;
    if (!this.analyser || !this.spectrum) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.5;
      source.connect(a);
      this.analyser = a;
      this.spectrum = new Float32Array(a.frequencyBinCount);
    }
    const spec = this.spectrum;
    this.analyser.getFloatFrequencyData(spec);
    const binHz = ctx.sampleRate / this.analyser.fftSize;
    const peak = (lo: number, hi: number): number => {
      let m = -Infinity;
      for (let i = Math.max(0, Math.floor(lo / binHz)); i <= Math.min(spec.length - 1, Math.ceil(hi / binHz)); i++) {
        if (spec[i] > m) m = spec[i];
      }
      return Number.isFinite(m) ? m : -160;
    };
    const track = this.stream?.getAudioTracks()[0];
    const s: MediaTrackSettings = track?.getSettings?.() ?? {};
    const nyquist = ctx.sampleRate / 2;
    return {
      rate: ctx.sampleRate,
      trackRate: typeof s.sampleRate === 'number' && s.sampleRate > 0 ? s.sampleRate : null,
      label: track?.label ?? '',
      echo: typeof s.echoCancellation === 'boolean' ? s.echoCancellation : null,
      audibleDb: peak(1000, 7000),
      ultraDb: nyquist > 15_000 ? peak(15_000, Math.min(20_000, nyquist)) : -160,
    };
  }

  /** ゲームの段階が終わったら呼ぶ。マイクを閉じる */
  close(): void {
    this.pause();
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
      this.analyser?.disconnect();
    } catch {
      // すでに外れている
    }
    this.analyser = null;
    this.spectrum = null;
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
