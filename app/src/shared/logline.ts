/** 本部の「ログ」の窓に流す1行（サーバーが記録の1行から作る。名前の付け方は CSV と同じ） */
export type LogLine = {
  id: number;
  /** サーバーの時刻（ms） */
  at: number;
  round: number;
  /** 段階の名前（タイマーの外は空） */
  phase: string;
  /** ラウンドの始まりからの経過（秒）。タイマーの外は null */
  el: number | null;
  /** 種類（英字の印） */
  kind: string;
  /** 種類の名前（日本語） */
  label: string;
  /** だれ（「#12 あお」） */
  who: string;
  /** 相手 */
  other: string;
  /** 方式（捕獲・解放のしかた） */
  via: string;
  /** 詳細（JSON の文字列。無ければ空） */
  data: string;
};

/** 細かすぎて、ふだんは隠す記録（長押し・音・光った/消えた・配役の1人ずつの役 など） */
export const LOG_NOISE = new Set(['role', 'hold', 'heard', 'run', 'run-end', 'rescue-hold', 'immune', 'meet-hold', 'migrate', 'mission-zone']);
