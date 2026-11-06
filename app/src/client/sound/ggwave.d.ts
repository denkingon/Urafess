/** ggwave（MIT, https://github.com/ggerganov/ggwave）の JS 版に型が無いので、使う分だけ書いておく */
declare module 'ggwave' {
  export interface GgwaveEnumValue {
    readonly value: number;
  }

  export interface GgwaveParameters {
    payloadLength: number;
    sampleRateInp: number;
    sampleRateOut: number;
    sampleRate: number;
    samplesPerFrame: number;
    soundMarkerThreshold: number;
    sampleFormatInp: GgwaveEnumValue;
    sampleFormatOut: GgwaveEnumValue;
    operatingMode: number;
  }

  export interface GgwaveModule {
    getDefaultParameters(): GgwaveParameters;
    init(parameters: GgwaveParameters): number;
    free(instance: number): void;
    /** 返り値は WASM のメモリを直接見ている。次の呼び出しで上書きされるので、すぐ写す */
    encode(instance: number, data: string, protocol: GgwaveEnumValue, volume: number): Int8Array;
    /** 受け取った音（sampleFormatInp の形式のバイト列）を渡すと、読み取れた文字のバイト列を返す（無ければ長さ0） */
    decode(instance: number, data: Int8Array | Uint8Array): Int8Array;
    disableLog(): void;
    enableLog(): void;
    rxToggleProtocol(protocol: GgwaveEnumValue, state: number): void;
    txToggleProtocol(protocol: GgwaveEnumValue, state: number): void;
    readonly ProtocolId: Record<string, GgwaveEnumValue>;
    readonly SampleFormat: Record<string, GgwaveEnumValue>;
    readonly GGWAVE_OPERATING_MODE_RX: number;
    readonly GGWAVE_OPERATING_MODE_TX: number;
    readonly GGWAVE_OPERATING_MODE_RX_AND_TX: number;
  }

  const factory: (moduleOverrides?: { print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<GgwaveModule>;
  export default factory;
}
