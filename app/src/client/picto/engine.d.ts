/** 裏フェス ピクトグラム（engine.js）。読み込むと window.URAFES_PICTO に入る。 */
export interface UrafesPicto {
  /** ファイル名にも使う id（例 "run"） */
  id: string;
  /** 日本語の名前（例 "逃げる"） */
  name: string;
  /** 動き入りの SVG。色は --tsuki --shu --tsuki-muted --chikko、すき間の色は --picto-ground */
  svg: string;
  /** 止めた姿の SVG */
  svgStatic: string;
}

export interface UrafesPictoApi {
  build(params?: { BEAT?: number }): { pictos: UrafesPicto[] };
}

declare global {
  interface Window {
    URAFES_PICTO: UrafesPictoApi;
  }
}
