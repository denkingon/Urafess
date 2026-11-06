import '../picto/engine.js';
import './player.css';
import type { PhoneView } from '../../shared/viewmodel';
import { COLOR, UI, esc, glyph, mix, say, sent, setHTML } from '../ui';

/**
 * 見た目の層：参加者の画面（全画面の元＝Phone）。ルールのアニメと同じ枠で描く。
 * 上＝段階バー、真ん中＝いまやることのピクト、下＝残り時間（URAJI）と人数の印、ひとこと。
 * しくみからは PhoneView だけを受け取る。値はパレット「裏フェス 画面のパレット」の既定（ui.ts と player.css）。
 */

export interface PhoneScreen {
  el: HTMLElement;
  /** 捕獲の画面などを差し込む場所（いちばん下。親指が届く） */
  slot: HTMLElement;
  update(view: PhoneView): void;
}

/** ピクトは拍ごとに1回だけ作る */
let pictos: Map<string, string> | null = null;
function pictoSVG(id: string): string {
  if (!pictos) {
    pictos = new Map();
    for (const p of window.URAFES_PICTO.build({ BEAT: UI.beat }).pictos) pictos.set(p.id, p.svg);
  }
  return pictos.get(id) ?? '';
}

const DEFAULT_TIMES = ['0:20', '1:00', '5:00', '2:00'];

export function createPhone(): PhoneScreen {
  const el = document.createElement('main');
  el.className = 'phone player';
  el.innerHTML = `
    <div class="p-offline" data-k="offline" hidden></div>
    <div class="p-bar" data-k="bar"></div>
    <div class="p-pic"><div class="p-box" data-k="pic"></div><div class="p-over u" data-k="over" hidden>×</div></div>
    <div class="p-time u" data-k="time" aria-live="polite"></div>
    <div class="p-counts" data-k="counts"></div>
    <div class="p-word" data-k="word"></div>
    <div class="p-note" data-k="note"></div>
    <div class="slot" data-k="slot"></div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const parts = {
    offline: q('offline'),
    bar: q('bar'),
    pic: q('pic'),
    over: q('over'),
    time: q('time'),
    counts: q('counts'),
    word: q('word'),
    note: q('note'),
  };
  setHTML(parts.offline, sent(['通信が切れている。タイマーはこのまま進む', 'Offline. The timer keeps running']));
  let last = '';
  let scene = '';

  return {
    el,
    slot: q('slot'),
    update(view) {
      const key = JSON.stringify(view);
      if (key === last) return;
      last = key;

      // 役（色と形）。捕まったら色が抜ける
      const role = view.caught ? 'caught' : view.role === '鬼' ? 'oni' : view.role === '逃走者' ? 'runner' : 'none';
      el.dataset.role = role;
      el.dataset.touch = view.touch;
      const rc = role === 'oni' ? COLOR.shu : role === 'runner' ? COLOR.tsuki : null;
      el.style.setProperty('--ground', rc ? mix(COLOR.yami, rc, UI.tint) : COLOR.yami);
      el.style.setProperty('--min', `${UI.minText}px`);
      parts.offline.hidden = !view.offline;

      // 段階バー：配役・0:20・1:00・5:00・2:00・結果（時間は主催者が決めた長さ）
      const times = view.times.length === 4 ? view.times : DEFAULT_TIMES;
      const labels = [say(['配役', 'ROLE']), ...times.map((t) => `<span class="t">${esc(t)}</span>`), say(['結果', 'END'])];
      setHTML(
        parts.bar,
        labels
          .map((lbl, i) => {
            const k = i + 1;
            const state = k < view.step ? 'done' : k === view.step ? 'now' : 'later';
            return `<div class="s ${state}"><i></i><span class="lbl">${lbl}</span></div>`;
          })
          .join(''),
      );

      // 絵
      if (view.scene !== scene) {
        scene = view.scene;
        parts.pic.innerHTML = pictoSVG(scene);
      }
      parts.pic.classList.toggle('lose', view.outcome === 'lose');
      parts.over.hidden = view.outcome !== 'lose';

      // 大きい数字（残り時間・待合室の人数）
      parts.time.hidden = !view.time;
      setHTML(parts.time, view.time ? `${esc(view.time)}${view.unit === 'person' ? `<span class="unit">${glyph.person}</span>` : ''}` : '');

      // 人数の印：鬼は角の頭、逃走者は点（捕まると白抜き）。多いときは数字
      const c = view.counts;
      const showCounts = !!c && view.step >= 1 && view.step <= 5;
      parts.counts.hidden = !showCounts;
      if (c && showCounts) {
        const marks = c.oni <= UI.marksMaxOni && c.runners <= UI.marksMaxRunners;
        setHTML(
          parts.counts,
          marks
            ? `<span class="grp oni">${glyph.oni.repeat(c.oni)}</span><span class="grp run">${Array.from({ length: c.runners }, (_, i) => `<i class="dot${i < c.left ? '' : ' out'}"></i>`).join('')}</span>`
            : `<span class="num oni">${glyph.oni}<span class="u">${c.oni}</span></span><span class="num run"><i class="dot"></i><span class="u">${c.left}/${c.runners}</span></span>`,
        );
      }

      // ひとことと、大事なときだけの文
      parts.word.hidden = !view.word;
      setHTML(parts.word, view.word ? say(view.word) : '');
      parts.note.hidden = !view.note;
      setHTML(parts.note, view.note ? sent(view.note) : '');
    },
  };
}

/** 主催者画面の大きい文字：数字は細め、漢字は1文字分で幅を見積もり、はみ出さない大きさにする */
export function bigFontSize(text: string, width: number): number {
  const em = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 256 ? 0.62 : 1), 0);
  return Math.max(24, Math.min(104, Math.floor((width - 6) / Math.max(em, 1))));
}
