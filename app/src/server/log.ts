import { VIA_NAME, type CaptureVia } from '../shared/capture';
import { PHASES } from '../shared/rules';

/** events テーブルの1行（1イベント＝1行） */
export type EventRow = {
  id: number;
  at: number;
  round: number;
  assign_id: number;
  /** 段階の番号（0〜3）。終わったあとは PHASES.length、タイマーの外は null */
  phase: number | null;
  /** ラウンドの始まりからの経過（ms、一時停止は数えない）。タイマーの外は null */
  elapsed: number | null;
  kind: string;
  pid: string | null;
  num: number | null;
  name: string | null;
  other_pid: string | null;
  other_num: number | null;
  other_name: string | null;
  via: string | null;
  data: string | null;
};

const KIND_NAME: Record<string, string> = {
  join: '入室',
  role: '役',
  assign: '配役',
  start: '開始',
  pause: '一時停止',
  resume: '再開',
  reset: 'やり直し',
  result: '結果',
  durations: '時間の設定',
  remove: '外す',
  clear: '部屋を空にする',
  hold: '長押し',
  heard: '音を拾った',
  nominate: '鬼が手動で選んだ',
  capture: '捕獲',
  cancel: '取り下げ',
  release: '捕獲の取り消し',
};

const HEADER = [
  '番号',
  '時刻（日本）',
  'ラウンド',
  '配役',
  '段階',
  '経過（秒）',
  '種類',
  'だれ（番号）',
  'だれ（名前）',
  '相手（番号）',
  '相手（名前）',
  '方式',
  '詳細',
];

/** Excel で文字化けしないよう、先頭に BOM を付けた CSV にする */
export function eventsToCsv(rows: readonly EventRow[]): string {
  const lines = [HEADER.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        jst(r.at),
        r.round,
        r.assign_id,
        phaseName(r.phase),
        r.elapsed === null ? '' : (r.elapsed / 1000).toFixed(1),
        kindName(r),
        r.num ?? '',
        r.name ?? '',
        r.other_num ?? '',
        r.other_name ?? '',
        r.via ? (VIA_NAME[r.via as CaptureVia] ?? r.via) : '',
        r.data ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function kindName(r: EventRow): string {
  const base = KIND_NAME[r.kind] ?? r.kind;
  if (r.kind !== 'hold' || !r.data) return base;
  try {
    const d = JSON.parse(r.data) as { on?: boolean };
    return d.on ? '長押し（押した）' : '長押し（離した）';
  } catch {
    return base;
  }
}

function phaseName(phase: number | null): string {
  if (phase === null) return '';
  return PHASES[phase]?.label ?? '終了後';
}

/** サーバーの時刻（UTC の ms）を日本時間の「2026-11-06 21:34:05.123」にする */
export function jst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function cell(v: unknown): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
