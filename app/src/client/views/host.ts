import { VIA_NAME } from '../../shared/capture';
import type { GameView, HostOp, HostSummary, Winner } from '../../shared/protocol';
import { allocateCounts, castCounts } from '../../shared/allocate';
import { CAST_SORTS, castStatText, DEFAULT_TAGS, sortCast, TAG_MAX_LEN, TAGS_MAX, type CastSort } from '../../shared/cast';
import {
  DEFAULT_RATIO,
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  isValidRatio,
  PHASES,
  RATIO_MAX,
  RATIO_MIN,
  ROLES,
  MATES_STALE_MS,
  RUN_STALE_MS,
  START_LEAD_MS,
  type RoleId,
  type WishMode,
} from '../../shared/rules';
import { isDone, positionAt } from '../../shared/schedule';
import { MISSION_DEFAULT_TITLE, MISSION_TITLE_MAX, PHOTO_STATUS_NAME, PHOTO_STORE_MAX_BYTES, type PhotoStatus } from '../../shared/mission';
import { glowPhase, hostStatus, wishNote } from '../../shared/viewmodel';
import { checkNewHostKey, HOST_KEY_MIN } from '../../shared/hostkey';
import type { ClientState } from '../core/game-client';
import type { Sensors } from '../sense';
import { createLightsBoard } from './glow';
import { createChatHost, type ChatHostScreen } from './chat-host';
import type { ChatJail, ChatMode } from '../../shared/chat';
import { createOverview, RING_BOX } from './overview';
import { AREA_MAX_PTS, AREA_MIN_PTS, isFarOutside } from '../../shared/area';
import { distanceM } from '../../shared/run';
import { bigFontSize } from './phone';
import { esc } from '../ui';

/** 主催者画面の大きい数字・文字の上限（「逃走者の勝ち」など長いときは枠に収まるまで縮める） */
const HOST_BIG_MAX_PX = 56;
/** 「次に進む」の行き先（いまの段階の番号ごと）。ゲームの段階の名前は「残り時間」なので、ここでは「ゲーム」と書く */
const SKIP_TO = ['追跡開始まで', 'ゲーム', '広場に戻るまで', '結果発表'] as const;
const GAME_PHASE = PHASES.findIndex((p) => p.id === 'game');
/** 待合室でこれより前に始めた夜のままなら、「新しい夜を始める」を促す */
const OLD_NIGHT_MS = 12 * 3_600_000;

/** 主催者の画面（キャンバスの「主催者」）。押せるボタンは今の段階で決まる */

export interface HostInput {
  game: GameView | null;
  host: HostSummary | null;
  serverNow: number;
  online: boolean;
  lastReject: { op: HostOp; reason: string } | null;
  /** 走ると光る：いま光っている全員 */
  glow?: ClientState['glow'];
  /** 全体の地図：全員の位置（主催者には役つきで届く） */
  mates?: ClientState['mates'];
  /** チャット：全部の回線（主催者には送った人と役つきで届く） */
  chat?: ClientState['chat'];
}

export interface HostActions {
  command(
    op: HostOp,
    extra?: {
      winner?: Winner;
      durations?: number[];
      ratio?: { oni: number; runner: number };
      mic?: 'always' | 'hold';
      wishMode?: WishMode;
      pids?: string[];
      role?: RoleId | null;
      tag?: string;
      on?: boolean;
      area?: [number, number][] | null;
      layer?: 'area' | 'jail';
      pid?: string;
      by?: string;
      rid?: string;
      ok?: boolean;
      title?: string;
      word?: string;
      photo?: string;
      free?: boolean;
      n?: number;
      chatMode?: ChatMode;
      chatJail?: ChatJail;
      places?: string[];
    },
  ): void;
  /** チャット：本部から送る（to＝all・oni・runner・pid:<その人>）。古い呼び出し側には無い */
  chat?(to: string, text: string): boolean;
  /** 1イベント＝1行の記録を CSV で保存する */
  downloadLog(): Promise<void>;
  /** ミッションの写真を取り出して、画面で使える URL にする */
  photo(id: string): Promise<string | null>;
  /** 全部の夜の写真の一覧 */
  album(): Promise<AlbumData>;
  /** 主催者の合言葉を変える。ok＝変えた（このスマホは新しい合言葉を覚える） */
  changeKey(value: string): Promise<KeyChangeResult>;
}

export type KeyChangeResult = 'ok' | 'short' | 'long' | 'denied' | 'offline';

export interface AlbumData {
  bytes: number;
  photos: { id: string; missionId: number; night: number; round: number; name: string; at: number; status: PhotoStatus; title: string }[];
}

export interface HostScreen {
  el: HTMLElement;
  update(input: HostInput): void;
  /** チャットの部品（本部が置き場所を変える・要対応に出す） */
  chat?: ChatHostScreen;
}

const ROLE_LABEL: Record<RoleId, string> = { oni: '鬼', runner: '逃走者' };

const REASONS: Record<string, string> = {
  stale: '別の主催者画面が先に操作した。今の状態に更新したので、もう一度確かめて押す。',
  'not-allowed': '今の段階ではできない操作。',
  'no-participants': 'まだ誰も入室していない。',
  'nobody-jailed': '牢屋に誰もいない。',
  'bad-input': '入力が正しくない。',
  'empty-role': 'その決め方だと、鬼か逃走者が0人になる。',
  'too-many-tags': `印は1人に${TAGS_MAX}つまで。`,
  'not-found': 'その人は見つからない（もう待っていない・つながっていない）。',
};

/** 範囲のおおよその大きさ（東西 × 南北） */
function areaSize(pts: [number, number][]): string {
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const ns = distanceM({ lat: Math.min(...lats), lon: lons[0] }, { lat: Math.max(...lats), lon: lons[0] });
  const ew = distanceM({ lat: lats[0], lon: Math.min(...lons) }, { lat: lats[0], lon: Math.max(...lons) });
  return `東西 約${Math.round(ew / 10) * 10}m × 南北 約${Math.round(ns / 10) * 10}m`;
}

export function createHost(actions: HostActions, sensors?: Sensors): HostScreen {
  const el = document.createElement('main');
  el.className = 'phone host';
  el.innerHTML = `
    <div class="host-head"><span class="host-title">主催者</span><span data-k="round"></span></div>
    <section class="status">
      <span data-k="title"></span>
      <span class="status-big" data-k="big"></span>
      <span data-k="next"></span>
    </section>
    <div class="stats">
      <div><b data-k="total"></b><span>参加</span></div>
      <div><b data-k="oni"></b><span>鬼</span></div>
      <div><b data-k="runner"></b><span>逃走者</span></div>
      <div><b data-k="received"></b><span>役の受け取り</span></div>
      <div><b data-k="synced"></b><span>時計が合っている</span></div>
      <div><b data-k="asks"></b><span>戻りたい人</span></div>
    </div>
    <p class="reject" data-k="reject" hidden></p>
    <p class="note" data-k="old" hidden></p>
    <section class="asks" data-k="asklist" hidden></section>
    <div class="buttons">
      <button type="button" data-op="assign"></button>
      <button type="button" data-op="start">開始</button>
      <button type="button" data-op="pause">一時停止</button>
      <button type="button" data-op="resume">再開</button>
      <button type="button" data-op="skip" class="wide">次に進む</button>
      <button type="button" data-op="win-oni">鬼の勝ち</button>
      <button type="button" data-op="win-runner">逃走者の勝ち</button>
      <button type="button" data-op="reset" class="wide">リセット（配役済みに戻す）</button>
      <button type="button" data-op="end" class="wide">夜を終える（全員の画面を SEE YOU AGAIN に）</button>
      <button type="button" data-op="clear" class="wide">新しい夜を始める（名簿は残す）</button>
    </div>
    <div class="mic-mode">
      <span>鬼のマイク</span>
      <div class="seg" role="group" aria-label="鬼のマイクの聞き方">
        <button type="button" data-mic="always" aria-pressed="false">ずっと聞く</button>
        <button type="button" data-mic="hold" aria-pressed="false">押している間だけ</button>
      </div>
      <p class="note" data-k="micNote"></p>
    </div>
    <div class="mic-mode wish-mode">
      <span>配役の決め方</span>
      <div class="seg" role="group" aria-label="配役の決め方">
        <button type="button" data-wishmode="wish" aria-pressed="false">希望を聞く</button>
        <button type="button" data-wishmode="lot" aria-pressed="false">くじだけ</button>
      </div>
      <p class="note" data-k="wishNote"></p>
    </div>
    <section class="cap-host cast-host" data-k="cast" hidden>
      <div class="cap-host-head"><b>配役をいじる</b><span data-k="castNow"></span></div>
      <p class="note" data-k="castNote"></p>
      <div class="cast-sort" role="group" aria-label="並べ方">
        ${CAST_SORTS.map((x) => `<button type="button" data-sort="${x.id}" aria-pressed="false">${x.label}</button>`).join('')}
      </div>
      <div class="cast-pick">
        <label>上から<input type="number" min="1" max="999" step="1" value="3" inputmode="numeric" data-k="castTop" aria-label="上から選ぶ人数">人</label>
        <button type="button" data-cast="top">選ぶ</button>
        <button type="button" data-cast="all">全員</button>
        <button type="button" data-cast="none">選ばない</button>
      </div>
      <div class="cast-list" data-k="castList"></div>
      <div class="cast-act" data-k="castAct">
        <b data-k="castSel"></b>
        <div class="cast-roles">
          <button type="button" data-cast="oni"></button>
          <button type="button" data-cast="runner"></button>
          <button type="button" data-cast="lot" class="ghost">指名を外す</button>
        </div>
        <div class="cast-tags" data-k="castTags"></div>
        <form data-k="castTagForm">
          <input type="text" maxlength="${TAG_MAX_LEN}" placeholder="新しい印（${TAG_MAX_LEN}文字まで）" aria-label="新しい印">
          <button type="submit">付ける</button>
        </form>
      </div>
    </section>
    <details class="durations">
      <summary>時間の設定</summary>
      <form>
        ${PHASES.map((p, i) => `<label>${p.label}<input type="number" min="1" max="3600" step="1" data-i="${i}" inputmode="numeric">秒</label>`).join('')}
        <button type="submit">時間を変える</button>
      </form>
    </details>
    <details class="ratio">
      <summary>鬼と逃走者の割合</summary>
      <form>
        <label>鬼<input type="number" min="${RATIO_MIN}" max="${RATIO_MAX}" step="1" data-r="oni" inputmode="numeric"></label>
        <label>逃走者<input type="number" min="${RATIO_MIN}" max="${RATIO_MAX}" step="1" data-r="runner" inputmode="numeric"></label>
        <p class="note" data-k="ratioPreview"></p>
        <button type="submit">割合を変える</button>
      </form>
    </details>
    <section class="cap-host area-host" data-k="area">
      <div class="cap-host-head"><b>遊ぶ範囲・牢屋</b><span data-k="areaNow"></span></div>
      <div class="area-layers" role="tablist">
        <button type="button" role="tab" data-layer="area" aria-selected="true"><b>遊ぶ範囲</b><span>まだ</span></button>
        <button type="button" role="tab" data-layer="jail" aria-selected="false"><b>牢屋</b><span>まだ</span></button>
      </div>
      <p class="note" data-k="areaNote">地図を押して角を足していく（3つ以上）。「決める」で全員の地図に線が出る。逃げ始めてからゲームの終わりまで、範囲の外へ 15m 出て3秒たった人のスマホに「戻れ」と戻る向きが出る。</p>
      <div class="area-map" data-k="areaMap"></div>
      <div class="area-btns">
        <button type="button" data-area="undo">1つ戻す</button>
        <button type="button" data-area="redo">描き直す</button>
        <button type="button" data-area="campus">メビウスリングの四角</button>
        <button type="button" data-area="save" class="primary">決める</button>
        <button type="button" data-area="none" class="ghost">範囲なしにする</button>
      </div>
    </section>
    <section class="cap-host" data-k="cap" hidden>
      <div class="cap-host-head"><b>捕獲と牢屋</b><span data-k="capCount"></span></div>
      <p class="note">逃走者を押すと、手で「捕まった」にする・取り消す。黒＝牢屋、点線＝本人が選んでいる途中、二重線＝牢屋から出た直後（捕まらない）。</p>
      <div class="cap-host-grid" data-k="capRunners"></div>
      <div class="mission" data-k="mission">
        <b>ミッション成功</b>
        <button type="button" data-mission="all">牢屋の全員を出す</button>
        <button type="button" data-mission="1">1人出す</button>
        <label><input type="number" min="1" max="999" step="1" value="2" inputmode="numeric" data-k="missionN">人出す</label>
        <button type="button" data-mission="n">出す</button>
        <p class="note">牢屋に入ったのが古い順に出る。押した瞬間に全員の画面が切り替わる。ゲームの段階の間だけ。</p>
      </div>
      <p class="note" data-k="capOni"></p>
    </section>
    <section class="cap-host glow-host" data-k="glow" hidden>
      <div class="cap-host-head"><b>全体の地図・走ると光る</b><span data-k="glowCount"></span></div>
      <p class="note" data-k="glowReady"></p>
      <button type="button" class="ghost" data-act="glow-map" hidden>地図の真ん中をこの画面の場所にする（位置を使う）</button>
      <div data-k="glowBoard"></div>
    </section>
    <section class="cap-host mission-host" data-k="missionPhoto">
      <div class="cap-host-head"><b>ミッション</b><span data-k="missionNow"></span></div>
      <form data-k="missionForm">
        <input type="text" maxlength="${MISSION_TITLE_MAX}" placeholder="${MISSION_DEFAULT_TITLE}" data-k="missionTitle" aria-label="ミッションの題">
        <button type="submit" data-k="missionGo">ミッションを出す</button>
      </form>
      <button type="button" class="ghost" data-k="missionClose" hidden>締め切る（成功した写真はそのまま）</button>
      <label class="mission-free-pick">「成功」で牢屋から
        <select data-k="missionFree" aria-label="成功で牢屋から出す人数">
          <option value="all" selected>全員を出す</option>
          <option value="1">1人出す</option>
          <option value="2">2人出す</option>
          <option value="3">3人出す</option>
          <option value="0">出さない</option>
        </select>
      </label>
      <p class="note">届いた写真を見て「成功」か「やり直し」を押す。成功は全員の画面に名前が出る。ゲームの段階なら、上で選んだ人数を牢屋から出す（入った順。1枚の写真で1回だけ）。写真そのものは結果発表で全員の画面に出る。</p>
      <div class="photo-grid" data-k="photoGrid"></div>
      <details class="album" data-k="album">
        <summary>写真（全部の夜）</summary>
        <p class="note" data-k="albumNote"></p>
        <div data-k="albumList"></div>
      </details>
    </section>
    <div class="dups" data-k="duplist"></div>
    <section class="cap-host names-host" data-k="names">
      <div class="cap-host-head"><b>名前の見張り</b><span data-k="namesNow"></span></div>
      <p class="note">使えない言葉の入った名前は、入るときと名前を変えるときに自動で弾く。すり抜けた名前はここで直す：「付け直させる」＝その人のスマホに名前を入れ直す画面が出る（試合中でも）／「切り替える」＝「不適切な名前にしたために名前を変更されたやつ」になり、本人は変えられない（戻すには「付け直させる」）。</p>
      <div class="names-list" data-k="nameList"></div>
      <details class="names-ban">
        <summary data-k="banSum">名前に使えない言葉</summary>
        <p class="note">最初から入っている言葉のほかに足せる。名前のどこかに入っていれば弾く。頭に = を付けると、その言葉ちょうどの名前（または区切った1語）だけ弾く（例：=しね はシネマを弾かない）。ひらがな・カタカナ・全角半角・空白や記号の違いは同じとみなす。</p>
        <form class="names-ban-form" data-k="banForm">
          <input type="text" data-k="banInput" maxlength="20" placeholder="例：うんこ" aria-label="足す言葉">
          <button type="submit">足す</button>
        </form>
        <div class="names-ban-list" data-k="banList"></div>
      </details>
    </section>
    <div class="spacer"></div>
    <button type="button" class="wide" data-op="csv">記録をCSVで保存（誰が・誰を・何分に）</button>
    <details class="key-change" data-k="keyChange">
      <summary>合言葉を変える</summary>
      <form>
        <label for="newkey">新しい合言葉</label>
        <input id="newkey" name="newkey" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" required>
        <p class="note">${HOST_KEY_MIN}文字以上（空白は数えない）。空白・大文字小文字・全角半角は、どう打っても合う。変えたあとも、最初に決めた合言葉は予備の鍵として効く（忘れたときに入れるように）。</p>
        <p class="note" data-k="keyResult" role="status" hidden></p>
        <button type="submit">合言葉を変える</button>
      </form>
    </details>
    <p class="note" data-k="foot"></p>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const btn = (op: string) => el.querySelector(`[data-op="${op}"]`) as HTMLButtonElement;
  const inputs = [...el.querySelectorAll('.durations input')] as HTMLInputElement[];
  const form = el.querySelector('.durations form') as HTMLFormElement;
  let editingDurations = false;
  const ratioInputs = [...el.querySelectorAll('.ratio input')] as HTMLInputElement[];
  const ratioForm = el.querySelector('.ratio form') as HTMLFormElement;
  let editingRatio = false;
  let totalNow = 0;
  const readRatio = () => ({
    oni: Number(ratioInputs.find((i) => i.dataset.r === 'oni')!.value),
    runner: Number(ratioInputs.find((i) => i.dataset.r === 'runner')!.value),
  });
  // いまの入室人数でこの割合だと、何人ずつになるか
  const showPreview = () => {
    const r = readRatio();
    q('ratioPreview').textContent = isValidRatio(r)
      ? totalNow > 0
        ? `いま${totalNow}人なら 鬼 ${allocateCounts(totalNow, ROLES.map((x) => ({ ...x, weight: r[x.id] })))[0]}人・逃走者 ${allocateCounts(totalNow, ROLES.map((x) => ({ ...x, weight: r[x.id] })))[1]}人。次の配役（引き直しも）から効く`
        : '次の配役（引き直しも）から効く'
      : `${RATIO_MIN}〜${RATIO_MAX}の整数で入れる`;
  };
  ratioInputs.forEach((i) => {
    i.addEventListener('focus', () => (editingRatio = true));
    i.addEventListener('input', showPreview);
  });
  ratioForm.addEventListener('submit', (e) => {
    e.preventDefault();
    editingRatio = false;
    const ratio = readRatio();
    if (isValidRatio(ratio)) actions.command('ratio', { ratio });
  });

  // 鬼のマイクの聞き方：いつでも切り替えられる（試合中でも、そのときから全員に効く）。どちらで記録したかは CSV に残る
  const micBtns = [...el.querySelectorAll('[data-mic]')] as HTMLButtonElement[];
  micBtns.forEach((b) =>
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      actions.command('mic', { mic: b.dataset.mic as 'always' | 'hold' });
    }),
  );

  // 合言葉を変える：打った字を見せて確かめてから送る。変わったら、このスマホは新しい合言葉を覚える
  const keyForm = q('keyChange').querySelector('form')!;
  const keyInput = keyForm.querySelector('input')!;
  const keySubmit = keyForm.querySelector('button')!;
  const keyResult = (message: string | null) => {
    q('keyResult').hidden = !message;
    q('keyResult').textContent = message ?? '';
  };
  keyInput.addEventListener('input', () => keyResult(null));
  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = keyInput.value.trim();
    if (!value || keySubmit.disabled) return;
    if (checkNewHostKey(value) === 'short') return keyResult(`短い。${HOST_KEY_MIN}文字以上にする（空白は数えない）`);
    if (checkNewHostKey(value) === 'long') return keyResult('長すぎる。');
    if (!confirm(`主催者の合言葉を「${value}」に変える。よいか？`)) return;
    keySubmit.disabled = true;
    keyResult('変えている…');
    void actions.changeKey(value).then((r) => {
      keySubmit.disabled = false;
      if (r === 'ok') {
        keyInput.value = '';
        keyResult(`変えた。新しい合言葉は「${value}」。このスマホは覚えた。ほかのスマホは、次に聞かれたときに新しい合言葉を打つ`);
        return;
      }
      keyResult(
        r === 'short'
          ? `短い。${HOST_KEY_MIN}文字以上にする（空白は数えない）`
          : r === 'long'
            ? '長すぎる。'
            : r === 'denied'
              ? '変えられなかった（このスマホの合言葉が古い）。画面を開き直して、入り直してからもう一度'
              : 'つながらない。電波を確かめて、もう一度押す',
      );
    });
  });

  // 配役の決め方：希望を聞く（割合は守る。枠より多い希望はくじ）／くじだけ。次の配役から効く
  const wishBtns = [...el.querySelectorAll('[data-wishmode]')] as HTMLButtonElement[];
  wishBtns.forEach((b) =>
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      actions.command('wish-mode', { wishMode: b.dataset.wishmode as WishMode });
    }),
  );

  // 配役をいじる：並べて、選んで、まとめて指名する／動かす／印を付ける
  const castSel = new Set<string>();
  let castSort: CastSort = 'num';
  let castOrder: string[] = [];
  let castTagsOf = new Map<string, string[]>();
  let lastCastKey = '';
  let redraw = (): void => {};
  const castTouch = () => {
    lastCastKey = '';
    redraw();
  };
  const sortBtns = [...el.querySelectorAll('[data-sort]')] as HTMLButtonElement[];
  sortBtns.forEach((b) =>
    b.addEventListener('click', () => {
      castSort = b.dataset.sort as CastSort;
      castTouch();
    }),
  );
  q('castList').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button[data-pid]') as HTMLButtonElement | null;
    if (!t?.dataset.pid) return;
    if (!castSel.delete(t.dataset.pid)) castSel.add(t.dataset.pid);
    castTouch();
  });
  q('cast').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button[data-cast]') as HTMLButtonElement | null;
    if (!t) return;
    const kind = t.dataset.cast;
    if (kind === 'top' || kind === 'all' || kind === 'none') {
      const n = kind === 'all' ? castOrder.length : kind === 'none' ? 0 : Math.floor(Number((q('castTop') as HTMLInputElement).value));
      if (!Number.isFinite(n) || n < 0) return;
      castSel.clear();
      for (const pid of castOrder.slice(0, n)) castSel.add(pid);
      castTouch();
      return;
    }
    if (castSel.size === 0) return;
    actions.command('cast', { pids: [...castSel], role: kind === 'lot' ? null : (kind as RoleId) });
    castSel.clear();
    castTouch();
  });
  // 印：選んだ全員に付いていれば外す。そうでなければ付ける
  const sendTag = (tag: string) => {
    const pids = [...castSel];
    if (pids.length === 0 || !tag) return;
    const all = pids.every((pid) => castTagsOf.get(pid)?.includes(tag));
    actions.command('tag', { pids: all ? pids : pids.filter((pid) => !castTagsOf.get(pid)?.includes(tag)), tag, on: !all });
  };
  q('castTags').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button[data-tag]') as HTMLButtonElement | null;
    if (t?.dataset.tag) sendTag(t.dataset.tag);
  });
  q('castTagForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = q('castTagForm').querySelector('input') as HTMLInputElement;
    const tag = input.value.normalize('NFKC').trim();
    if (!tag || castSel.size === 0) return;
    sendTag(tag);
    input.value = '';
  });

  btn('csv').addEventListener('click', () => {
    const b = btn('csv');
    b.disabled = true;
    void actions
      .downloadLog()
      .catch(() => alert('記録を取り出せなかった。通信を確かめてもう一度押す。'))
      .finally(() => (b.disabled = false));
  });
  q('capRunners').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t?.dataset.pid) return;
    const label = t.dataset.label ?? '';
    if (t.dataset.state === 'caught') {
      if (confirm(`${label} の捕獲を取り消す。よいか？`)) actions.command('release', { pid: t.dataset.pid });
    } else if (confirm(`${label} を、手で「捕まった」にする（鬼は空欄）。よいか？`)) {
      actions.command('capture', { pid: t.dataset.pid });
    }
  });
  // ミッション成功：全員／1人／人数を決めて（ミッションの版ごとに使い分ける）
  q('mission').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button[data-mission]') as HTMLButtonElement | null;
    if (!t) return;
    const kind = t.dataset.mission;
    const n = kind === 'all' ? undefined : kind === '1' ? 1 : Math.round(Number((q('missionN') as HTMLInputElement).value));
    if (n !== undefined && !(Number.isInteger(n) && n >= 1)) return;
    actions.command('mission-free', n === undefined ? {} : { n });
  });
  btn('assign').addEventListener('click', () => actions.command('assign'));
  btn('start').addEventListener('click', () => actions.command('start'));
  btn('pause').addEventListener('click', () => actions.command('pause'));
  btn('resume').addEventListener('click', () => actions.command('resume'));
  // 次に進む：ゲームの段階を縮めるときだけ確かめる（ほかの段階は待ち時間なので、そのまま進める）
  let skipConfirm: string | null = null;
  btn('skip').addEventListener('click', () => {
    if (skipConfirm && !confirm(skipConfirm)) return;
    actions.command('skip');
  });
  btn('win-oni').addEventListener('click', () => actions.command('result', { winner: 'oni' }));
  btn('win-runner').addEventListener('click', () => actions.command('result', { winner: 'runner' }));
  btn('reset').addEventListener('click', () => {
    if (confirm('タイマーを止めて、配役済みに戻す。役はそのまま。よいか？')) actions.command('reset');
  });
  btn('end').addEventListener('click', () => {
    if (confirm('夜を終える。全員の画面が SEE YOU AGAIN になる。配役で再開もできる。よいか？')) actions.command('end');
  });
  btn('clear').addEventListener('click', () => {
    if (confirm('今夜の参加者を全員外して、新しい夜にする（配役前に戻る）。名簿は残るので、スマホには名前のボタンが出て、押せば入れる。よいか？')) {
      actions.command('clear');
    }
  });
  q('asklist').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.rid) return;
    const ok = b.dataset.ok === '1';
    if (ok && b.dataset.here === '1' && !confirm(`${b.dataset.name} はいまも別のスマホでつながっている。それでもつなぐか？`)) return;
    actions.command('link', { rid: b.dataset.rid, ok });
  });
  inputs.forEach((i) => i.addEventListener('focus', () => (editingDurations = true)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    editingDurations = false;
    const durations = inputs.map((i) => Math.round(Number(i.value) * 1000));
    if (durations.every((d) => Number.isInteger(d) && d >= DURATION_MIN_MS && d <= DURATION_MAX_MS)) {
      actions.command('durations', { durations });
    }
  });
  q('duplist').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const pid = target.dataset.pid;
    if (pid && confirm(`${target.dataset.label} を参加者から外す。よいか？`)) actions.command('remove', { pid });
  });

  // 名前の見張り
  q('nameList').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.pid) return;
    const name = b.dataset.name ?? '';
    if (b.dataset.nop === 'redo') {
      if (confirm(`「${name}」に名前を付け直させる。付け直すまで名前は「名前を付け直し中」になる。よいか？`)) actions.command('name-redo', { pid: b.dataset.pid });
    } else if (b.dataset.nop === 'shame') {
      if (confirm(`「${name}」の名前を「不適切な名前にしたために名前を変更されたやつ」に切り替える。本人は変えられない。よいか？`)) actions.command('name-shame', { pid: b.dataset.pid });
    }
  });
  q('banForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = q('banInput') as HTMLInputElement;
    const word = input.value.trim();
    if (!word) return;
    actions.command('ban-add', { word });
    input.value = '';
  });
  q('banList').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (b?.dataset.word !== undefined && confirm(`「${b.dataset.word}」を使えない言葉から外す。よいか？`)) actions.command('ban-remove', { word: b.dataset.word });
  });

  // ミッション
  const missionForm = q('missionForm') as HTMLFormElement;
  const missionTitle = q('missionTitle') as HTMLInputElement;
  let missionOpen = false;
  missionForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = missionTitle.value.trim() || MISSION_DEFAULT_TITLE;
    if (missionOpen && !confirm(`いまのミッションを締め切って、「${title}」を出す。よいか？`)) return;
    actions.command('mission', { title });
    missionTitle.value = '';
  });
  q('missionClose').addEventListener('click', () => {
    if (confirm('ミッションを締め切る。もう写真は送れなくなる。よいか？')) actions.command('mission-close');
  });
  const onPhotoClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const b = t.closest('button') as HTMLButtonElement | null;
    if (b?.dataset.photo) {
      const ok = b.dataset.ok === '1';
      const pick = (q('missionFree') as HTMLSelectElement).value;
      const free = ok && pick !== '0';
      actions.command('judge', free ? { photo: b.dataset.photo, ok, free, ...(pick === 'all' ? {} : { n: Number(pick) }) } : { photo: b.dataset.photo, ok });
      return;
    }
    // 写真を押すと大きくする・戻す
    const fig = t.closest('figure');
    if (fig && t.tagName === 'IMG') fig.classList.toggle('is-big');
  };
  q('photoGrid').addEventListener('click', onPhotoClick);
  q('albumList').addEventListener('click', onPhotoClick);
  // 全部の夜の写真は、画面に入ったものだけ取りに行く（全部を一度に読むと、主催者のスマホが落ちる）
  const lazy =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              if (!en.isIntersecting) continue;
              const img = en.target as HTMLImageElement;
              lazy!.unobserve(img);
              void actions.photo(img.dataset.id!).then((url) => {
                if (url) img.src = url;
              });
            }
          },
          { rootMargin: '200px' },
        )
      : null;
  const album = q('album') as HTMLDetailsElement;
  album.addEventListener('toggle', () => {
    if (album.open) void showAlbum();
  });
  async function showAlbum(): Promise<void> {
    q('albumNote').textContent = '読み込んでいる…';
    try {
      const data = await actions.album();
      q('albumNote').textContent = `${data.photos.length}枚・保存 ${mb(data.bytes)} / ${mb(PHOTO_STORE_MAX_BYTES)}。名簿と同じく、新しい夜を始めても消えない。`;
      const groups = new Map<string, AlbumData['photos']>();
      for (const ph of data.photos) {
        const k = `夜${ph.night}・ラウンド${Math.max(ph.round, 0)}「${ph.title}」`;
        groups.set(k, [...(groups.get(k) ?? []), ph]);
      }
      q('albumList').replaceChildren(
        ...[...groups.entries()].reverse().map(([k, list]) => {
          const box = document.createElement('div');
          box.className = 'album-group';
          const h = document.createElement('div');
          h.className = 'album-head';
          h.textContent = k;
          const grid = document.createElement('div');
          grid.className = 'photo-grid';
          grid.append(...list.map((ph) => photoFigure(ph.id, `${ph.name}・${clock(ph.at)}・${PHOTO_STATUS_NAME[ph.status]}`, ph.status, null, true)));
          box.append(h, grid);
          return box;
        }),
      );
    } catch {
      q('albumNote').textContent = '読み込めなかった。閉じてもう一度開く。';
    }
  }
  /** 写真1枚（主催者が見る）。buttons を渡すと「成功」「やり直し」を付ける */
  function photoFigure(id: string, label: string, status: PhotoStatus, buttons: { id: string } | null, later = false): HTMLElement {
    const fig = document.createElement('figure');
    fig.dataset.status = status;
    const img = document.createElement('img');
    img.alt = label;
    img.decoding = 'async';
    img.dataset.id = id;
    if (later && lazy) lazy.observe(img);
    else
      void actions.photo(id).then((url) => {
        if (url) img.src = url;
      });
    const cap = document.createElement('figcaption');
    cap.textContent = label;
    fig.append(img, cap);
    if (buttons) {
      const row = document.createElement('div');
      row.className = 'photo-judge';
      for (const [text, ok] of [['成功', '1'], ['やり直し', '0']] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.dataset.photo = buttons.id;
        b.dataset.ok = ok;
        b.classList.toggle('primary', (ok === '1' && status === 'ok') || (ok === '0' && status === 'no'));
        row.append(b);
      }
      fig.append(row);
    }
    return fig;
  }
  let lastPhotoKey = '';

  let lastDupKey = '';
  let lastCapKey = '';
  let lastNamesKey = '';
  let lastAskKey = '';
  // 走ると光る：主催者の画面にも光の地図（真ん中はこの画面の場所。たいてい広場）
  const board = createLightsBoard({ listMax: 6, start: 'all', labelMax: 60 });
  q('glowBoard').append(board.el);
  const glowMap = el.querySelector('[data-act="glow-map"]') as HTMLButtonElement;
  glowMap.addEventListener('click', () => sensors?.request());

  // 遊ぶ範囲と牢屋の場所：同じ道具で描く（上の札で切りかえ）。地図を押して角を足す（下書き）→「決める」で送る。試合中は描けない
  type Layer = 'area' | 'jail';
  let layer: Layer = 'area';
  const drafts: Record<Layer, [number, number][]> = { area: [], jail: [] };
  const saved: Record<Layer, [number, number][] | null> = { area: null, jail: null };
  let areaLocked = false;
  const LAYER_TEXT: Record<Layer, { none: string; note: string; clear: string; confirm: string }> = {
    area: {
      none: '範囲なし',
      note: '地図を押して角を足していく（3つ以上）。「決める」で全員の地図に線が出る。逃げ始めてからゲームの終わりまで、範囲の外へ 15m 出て3秒たった人のスマホに「戻れ」と戻る向きが出る。',
      clear: '範囲なしにする',
      confirm: '遊ぶ範囲をなくす（どこまで行っても「戻れ」は出ない）。よいか？',
    },
    jail: {
      none: 'まだ決めていない',
      note: '牢屋にする場所を、地図を押して角で囲む（3つ以上）。「決める」で全員の地図に「牢屋」が出る。捕まった人のスマホに、牢屋への向きと距離が出る（着いたら「牢屋に着いた」）。',
      clear: '牢屋の場所をなくす',
      confirm: '牢屋の場所をなくす（捕まった人に向きが出なくなる）。よいか？',
    },
  };
  const draw = () => {
    const d = drafts[layer];
    areaMap.update({
      me: null,
      meKind: 'unknown',
      meLit: false,
      points: [],
      labelMax: 0,
      area: saved.area,
      jail: saved.jail,
      draft: d.length ? d : null,
      draftLayer: layer,
      frameBase: 'campus',
    });
  };
  const areaMap = createOverview({
    onTap: (p) => {
      const d = drafts[layer];
      if (areaLocked || d.length >= AREA_MAX_PTS) return;
      drafts[layer] = [...d, [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]];
      draw();
      refreshAreaBtns();
    },
  });
  q('areaMap').append(areaMap.el);
  const areaBtn = (k: string) => el.querySelector(`[data-area="${k}"]`) as HTMLButtonElement;
  const layerBtns = [...el.querySelectorAll<HTMLButtonElement>('[data-layer]')];
  const refreshAreaHead = () => {
    const pts = saved[layer];
    q('areaNow').textContent = pts ? `決まっている（角 ${pts.length}・${areaSize(pts)}）` : LAYER_TEXT[layer].none;
    q('areaNote').textContent = areaLocked
      ? '試合中は変えられない（走っている人の「外」や牢屋が急に変わらないように）。時間が0になったら変えられる。'
      : LAYER_TEXT[layer].note;
    areaBtn('none').textContent = LAYER_TEXT[layer].clear;
    for (const b of layerBtns) {
      const on = b.dataset.layer === layer;
      b.setAttribute('aria-selected', String(on));
      const st = b.querySelector('span');
      if (st) st.textContent = saved[b.dataset.layer as Layer] ? '決まっている' : 'まだ';
    }
  };
  const refreshAreaBtns = () => {
    const d = drafts[layer];
    areaBtn('undo').disabled = areaLocked || d.length === 0;
    areaBtn('redo').disabled = areaLocked || d.length === 0;
    areaBtn('campus').hidden = layer !== 'area';
    areaBtn('campus').disabled = areaLocked;
    areaBtn('save').disabled = areaLocked || d.length < AREA_MIN_PTS;
    areaBtn('none').disabled = areaLocked || !saved[layer];
  };
  for (const b of layerBtns) {
    b.addEventListener('click', () => {
      layer = b.dataset.layer as Layer;
      el.querySelector('[data-k="area"]')!.setAttribute('data-layer', layer);
      refreshAreaHead();
      refreshAreaBtns();
      draw();
    });
  }
  areaBtn('undo').addEventListener('click', () => {
    drafts[layer] = drafts[layer].slice(0, -1);
    draw();
    refreshAreaBtns();
  });
  areaBtn('redo').addEventListener('click', () => {
    drafts[layer] = [];
    draw();
    refreshAreaBtns();
  });
  areaBtn('campus').addEventListener('click', () => {
    drafts.area = [
      [RING_BOX.north, RING_BOX.west],
      [RING_BOX.north, RING_BOX.east],
      [RING_BOX.south, RING_BOX.east],
      [RING_BOX.south, RING_BOX.west],
    ];
    draw();
    refreshAreaBtns();
  });
  areaBtn('save').addEventListener('click', () => {
    const d = drafts[layer];
    if (d.length < AREA_MIN_PTS) return;
    actions.command('area', { area: d, layer });
    saved[layer] = d;
    drafts[layer] = [];
    draw();
    refreshAreaHead();
    refreshAreaBtns();
  });
  areaBtn('none').addEventListener('click', () => {
    if (confirm(LAYER_TEXT[layer].confirm)) actions.command('area', { area: null, layer });
  });

  // チャット：流れと送る欄・制約。同じ名前の一覧の上に置く
  const chatHost = createChatHost({
    chat: (to, text) => actions.chat?.(to, text) ?? false,
    command: (op, extra) => actions.command(op, extra),
  });
  q('duplist').before(chatHost.feed, chatHost.settings);

  const screen: HostScreen = {
    el,
    chat: chatHost,
    update(input) {
      const { game, host, serverNow, online, lastReject } = input;
      chatHost.update({ game, chat: input.chat, online });
      if (!game || !host) return;
      redraw = () => screen.update(input);
      {
        // 遊ぶ範囲・牢屋の場所
        const next: Record<Layer, [number, number][] | null> = { area: game.area?.pts ?? null, jail: game.jail?.pts ?? null };
        // サーバーと同じ決まり：試合中（時間が0になる前）は変えられない
        const locked = game.stage === 'timer' && !!game.timer && !isDone(game.timer, serverNow);
        const changed = JSON.stringify(next) !== JSON.stringify(saved) || locked !== areaLocked;
        saved.area = next.area;
        saved.jail = next.jail;
        areaLocked = locked;
        if (changed) {
          q('area').classList.toggle('is-locked', locked);
          refreshAreaHead();
          refreshAreaBtns();
        }
        draw();
      }
      const s = hostStatus(game, serverNow);
      q('round').textContent = `ラウンド ${Math.max(game.round, 1)}${online ? '' : '・切断中'}`;
      q('title').textContent = s.title;
      const big = q('big');
      big.textContent = s.big;
      big.style.fontSize = `${Math.min(HOST_BIG_MAX_PX, bigFontSize(s.big, big.clientWidth || 290))}px`;
      q('next').textContent = s.next;
      q('total').textContent = String(host.total);
      const assigned = game.stage !== 'lobby';
      q('oni').textContent = assigned ? String(game.counts.oni) : '—';
      q('runner').textContent = assigned ? String(game.counts.runner) : '—';
      q('received').textContent = assigned ? `${host.received}/${host.assigned}` : '—';
      q('synced').textContent = `${host.synced}/${host.connected}`;
      const asks = host.reclaims ?? [];
      q('asks').textContent = asks.length ? `${asks.length}人` : 'なし';
      q('foot').textContent =
        `時間：${PHASES.map((p, i) => `${p.label} ${fmt(game.durations[i])}`).join(' → ')}` +
        `　／　割合 鬼${(game.ratio ?? DEFAULT_RATIO).oni}：逃走者${(game.ratio ?? DEFAULT_RATIO).runner}` +
        `　／　鬼のマイク ${(game.micMode ?? 'always') === 'always' ? 'ずっと聞く' : '押している間だけ'}` +
        `　／　配役 ${(game.wishMode ?? 'lot') === 'wish' ? '希望を聞く' : 'くじだけ'}` +
        (host.waiting ? `　／　次の配役を待っている人 ${host.waiting}人` : '') +
        (host.registry !== undefined ? `　／　名簿 ${host.registry}人` : '');
      // 前の夜のまま集め始めないように：待合室で、夜を始めてから半日以上たっていたら知らせる
      const old = q('old');
      const age = game.nightAt !== undefined ? serverNow - game.nightAt : 0;
      old.hidden = !(game.stage === 'lobby' && age > OLD_NIGHT_MS);
      old.textContent = old.hidden ? '' : `この夜は${fmtAge(age)}前に始めたまま。今夜集めるなら、先に「新しい夜を始める」を押す。`;

      const askKey = JSON.stringify(asks);
      if (askKey !== lastAskKey) {
        lastAskKey = askKey;
        const list = q('asklist');
        list.hidden = asks.length === 0;
        list.replaceChildren(
          ...asks.map((a) => {
            const row = document.createElement('div');
            row.className = 'ask-row';
            const label = document.createElement('span');
            label.textContent = a.here ? `「${a.name}」に戻りたい人（${a.name}はいまも別のスマホでつながっている）` : `「${a.name}」に戻りたい人`;
            const yes = document.createElement('button');
            yes.type = 'button';
            yes.className = 'primary';
            yes.textContent = 'つなぐ';
            const no = document.createElement('button');
            no.type = 'button';
            no.textContent = '断る';
            for (const [b, ok] of [[yes, '1'], [no, '0']] as const) {
              b.dataset.rid = a.rid;
              b.dataset.ok = ok;
              b.dataset.name = a.name;
              b.dataset.here = a.here ? '1' : '0';
            }
            row.append(label, yes, no);
            return row;
          }),
        );
      }

      const reject = q('reject');
      reject.hidden = !lastReject;
      reject.textContent = lastReject ? REASONS[lastReject.reason] ?? lastReject.reason : '';

      const timer = game.timer;
      const done = game.stage === 'timer' && timer !== null && isDone(timer, serverNow);
      const canAssign = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result' || game.stage === 'ended' || done;
      btn('assign').textContent =
        game.stage === 'assigned'
          ? '引き直し'
          : game.stage === 'ended'
            ? '再開（次のラウンドの配役）'
            : game.stage === 'result' || done
              ? '次のラウンド（配役）'
              : '配役';
      setEnabled(btn('assign'), canAssign && host.total > 0, game.stage === 'lobby' || game.stage === 'result' || done);
      setEnabled(btn('start'), game.stage === 'assigned', game.stage === 'assigned');
      const running = game.stage === 'timer' && timer?.status === 'running' && !done;
      setEnabled(btn('pause'), running, running);
      const paused = game.stage === 'timer' && timer?.status === 'paused';
      setEnabled(btn('resume'), paused, paused);
      // 次に進む：いまの段階を2秒後に終わらせる。行き先をボタンに書く。あと2秒ほどで終わるときは押せない
      const pos = running && timer ? positionAt(timer, serverNow) : null;
      const phaseNow = pos && pos.kind === 'phase' ? pos : null;
      const goTo = phaseNow ? (SKIP_TO[phaseNow.index] ?? '結果発表') : null;
      btn('skip').textContent = goTo ? `次に進む → ${goTo}` : '次に進む';
      skipConfirm = phaseNow && phaseNow.index === GAME_PHASE ? `ゲームを終えて「${goTo}」へ進む。よいか？` : null;
      setEnabled(btn('skip'), !!phaseNow && phaseNow.remainingMs > START_LEAD_MS + 500, false);
      setEnabled(btn('end'), game.stage !== 'ended' && (game.stage !== 'timer' || done), game.stage === 'result');
      setEnabled(btn('reset'), game.stage === 'timer' || (game.stage === 'result' && game.assignId > 0), false);
      // 新しい夜は、誰もいなくても始められる（前の夜のままなら目立たせる）
      setEnabled(btn('clear'), game.stage !== 'timer' || done, !old.hidden);
      const canResult = game.stage === 'result' || done;
      setEnabled(btn('win-oni'), canResult, canResult && !game.result);
      setEnabled(btn('win-runner'), canResult, canResult && !game.result);

      const canEditDurations = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result';
      inputs.forEach((input, i) => {
        input.disabled = !canEditDurations;
        if (!editingDurations) input.value = String(Math.round(game.durations[i] / 1000));
      });
      (form.querySelector('button') as HTMLButtonElement).disabled = !canEditDurations;

      const mic = game.micMode ?? 'always';
      micBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mic === mic)));
      q('micNote').textContent =
        mic === 'always'
          ? 'マイクをオンにした鬼は、押さなくても聞いている。逃走者の長押しの間に拾えば記録される'
          : '鬼は「捕まえた」を押している間だけ聞く（前の版と同じ）';

      const wishMode = game.wishMode ?? 'lot';
      wishBtns.forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.wishmode === wishMode));
        // 古いサーバー（決め方を送ってこない）では切り替えられない
        b.disabled = !canEditDurations || game.wishMode === undefined;
      });
      q('wishNote').textContent = wishNote(game, host);

      // 配役をいじる
      const cast = host.cast;
      q('cast').hidden = !cast;
      if (cast) {
        // 試合中（時間が0になる前）は役を動かせない。印はいつでも付けられる
        const castOpen = !(game.stage === 'timer' && !done);
        const moving = game.stage === 'assigned';
        const here = new Set(cast.map((c) => c.pid));
        for (const pid of [...castSel]) if (!here.has(pid)) castSel.delete(pid);
        const key = JSON.stringify([cast, [...castSel], castSort, game.stage, castOpen, game.ratio]);
        if (key !== lastCastKey) {
          lastCastKey = key;
          const order = sortCast(cast, castSort);
          castOrder = order.map((c) => c.pid);
          castTagsOf = new Map(cast.map((c) => [c.pid, c.tags ?? []]));
          sortBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === castSort)));
          const pinOni = cast.filter((c) => c.pin === 'oni').length;
          const pinRunner = cast.filter((c) => c.pin === 'runner').length;
          const ratioNow = game.ratio ?? DEFAULT_RATIO;
          const plan = castCounts(cast.length, ROLES.map((x) => ({ ...x, weight: ratioNow[x.id] })), ROLES.map((x) => (x.id === 'oni' ? pinOni : pinRunner)));
          q('castNow').textContent =
            (pinOni + pinRunner > 0 ? `指名 鬼${pinOni}・逃走者${pinRunner}` : '指名なし') +
            (moving || !castOpen ? '' : plan ? `　配役すると 鬼${plan[0]}・逃走者${plan[1]}` : '　このままだと片方が0人（配役できない）');
          q('castNote').textContent = !castOpen
            ? '試合中は役を動かせない。印は付けられる。'
            : moving
              ? '選んで「動かす」を押すと、その場で役が変わる（本人の画面もすぐ変わる）。希望とちがう役に動かした人は、次の配役で優先される。'
              : '並べて、選んで、指名する。指名した人は、希望やくじより先にその役になる（残りは希望とくじ）。割合の枠より多く指名したら、指名のとおりの人数になる。希望とちがう役に指名した人は、次の配役で優先される。指名は「開始」で消える。';
          q('castList').replaceChildren(
            ...order.map((c) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = 'cast-row';
              b.dataset.pid = c.pid;
              b.dataset.on = c.on ? '1' : '0';
              b.setAttribute('aria-pressed', String(castSel.has(c.pid)));
              const head = document.createElement('span');
              head.className = 'cast-name';
              head.textContent = `${c.num} ${c.name}${c.on ? '' : '（切断中）'}`;
              const marks = document.createElement('span');
              marks.className = 'cast-marks';
              const mark = (text: string, kind: string) => {
                const m = document.createElement('i');
                m.dataset.kind = kind;
                m.textContent = text;
                marks.append(m);
              };
              // 配役済みなら「いま」の役。次の配役の前なら、前のラウンドの役
              if (c.role) mark(moving ? `いま ${ROLE_LABEL[c.role]}` : `前回 ${ROLE_LABEL[c.role]}`, moving ? 'role' : 'last');
              if (c.pin) mark(`指名 ${ROLE_LABEL[c.pin]}`, 'pin');
              if (c.wish) mark(`希望 ${ROLE_LABEL[c.wish]}`, 'wish');
              if (c.prio) mark('優先', 'prio');
              for (const t of c.tags ?? []) mark(t, 'tag');
              b.append(head, marks);
              const st = castStatText(c.stat);
              if (st) {
                const line = document.createElement('span');
                line.className = 'cast-stat';
                line.textContent = st;
                b.append(line);
              }
              return b;
            }),
          );
          const n = castSel.size;
          q('castAct').hidden = n === 0;
          q('castSel').textContent = `${n}人を選んでいる`;
          const roleBtns = [...q('castAct').querySelectorAll('.cast-roles button')] as HTMLButtonElement[];
          for (const rb of roleBtns) {
            rb.disabled = !castOpen;
            if (rb.dataset.cast === 'oni') rb.textContent = moving ? '鬼へ動かす' : '鬼に指名';
            if (rb.dataset.cast === 'runner') rb.textContent = moving ? '逃走者へ動かす' : '逃走者に指名';
          }
          // 印：はじめからある印＋誰かに付いている印。選んだ全員に付いていれば「外す」
          const known = [...new Set([...DEFAULT_TAGS, ...cast.flatMap((c) => c.tags ?? [])])];
          const picked = cast.filter((c) => castSel.has(c.pid));
          q('castTags').replaceChildren(
            ...known.map((t) => {
              const tb = document.createElement('button');
              tb.type = 'button';
              tb.dataset.tag = t;
              const all = picked.length > 0 && picked.every((c) => c.tags?.includes(t));
              tb.setAttribute('aria-pressed', String(all));
              tb.textContent = all ? `${t} を外す` : `${t} を付ける`;
              return tb;
            }),
          );
        }
      }

      const canEditRatio = canEditDurations;
      const ratio = game.ratio ?? DEFAULT_RATIO;
      totalNow = host.total;
      ratioInputs.forEach((input) => {
        input.disabled = !canEditRatio;
        if (!editingRatio) input.value = String(ratio[input.dataset.r as 'oni' | 'runner']);
      });
      (ratioForm.querySelector('button') as HTMLButtonElement).disabled = !canEditRatio;
      if (!editingRatio) showPreview();

      const cap = host.capture;
      q('cap').hidden = !cap || !(game.stage === 'timer' || game.stage === 'result');
      if (cap) {
        const caught = cap.runners.filter((r) => r.caught).length;
        q('capCount').textContent = `牢屋 ${caught}/${cap.runners.length}人${game.allCaughtAt != null ? '（全員が入った）' : ''}`;
        // ミッション成功は、ゲームの段階の間で、牢屋に誰かいて、まだ全員は入っていないときだけ押せる
        const tm = game.stage === 'timer' && game.timer ? positionAt(game.timer, serverNow) : null;
        const missionOk = !!tm && tm.kind === 'phase' && tm.index === GAME_PHASE && caught > 0 && game.allCaughtAt == null;
        for (const b of q('mission').querySelectorAll('button')) (b as HTMLButtonElement).disabled = !missionOk;
        const capKey = JSON.stringify(cap);
        if (capKey !== lastCapKey) {
          lastCapKey = capKey;
          q('capRunners').replaceChildren(
            ...cap.runners.map((r) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.dataset.pid = r.pid;
              b.dataset.state = r.caught ? 'caught' : r.open ? 'open' : r.freeUntil ? 'immune' : 'free';
              b.dataset.label = r.name;
              const saved = r.rescues ? `（${r.rescues}人出した）` : '';
              b.textContent = r.caught ? `${r.name} ← ${r.byName ?? '手'}・${r.via ? VIA_NAME[r.via] : ''}` : `${r.name}${saved}`;
              return b;
            }),
          );
          q('capOni').textContent = cap.oni.length
            ? `鬼の捕まえた数：${cap.oni.map((o) => `${o.name} ${o.catches}`).join('　')}`
            : '';
        }
      }

      // 走ると光る：配役〜ゲームの終わりは、センサーの使える人の数。ゲームの段階は光っている人と地図
      const gp = glowPhase(game, serverNow);
      sensors?.setActive(gp !== 'none');
      q('glow').hidden = gp === 'none';
      if (gp !== 'none') {
        const g = host.glow;
        // 光っている人の数は、届いている光の一覧から（集計は 0.5 秒ごとなので遅れる）
        const litNow = (input.glow?.runs ?? []).filter((r) => serverNow - r.at <= RUN_STALE_MS).length;
        const onMap = (input.mates?.people ?? []).filter((m) => serverNow - m.at <= MATES_STALE_MS);
        const oniOn = onMap.filter((m) => m.role === 'oni').length;
        const areaPts = game.area?.pts ?? null;
        const outside = areaPts ? onMap.filter((m) => isFarOutside(areaPts, m)) : [];
        q('glowCount').textContent =
          gp === 'live'
            ? `地図に 鬼${oniOn}・逃走者${onMap.length - oniOn}　光っている ${litNow}人` +
              (areaPts ? (outside.length ? `　範囲の外 ${outside.length}人（${outside.map((m) => m.name).join('・')}）` : '　範囲の外 0人') : '')
            : 'ゲームの段階で地図に出る・光る';
        q('glowReady').textContent = g
          ? `いまつながっている配役の人 ${g.total}人のうち、動きのセンサーが使える ${g.motion}人・位置が使える ${g.geo}人。` +
            (g.total > 0 && (g.motion < g.total || g.geo < g.total) ? '足りない人は、画面の「走ると光るをオンにする」を押す。' : '')
          : '';
        glowMap.hidden = !sensors || !sensors.needsTap;
        board.el.hidden = gp !== 'live';
        if (gp === 'live') {
          const now = Date.now();
          const pos = sensors?.position(now) ?? null;
          board.update({
            glow: input.glow ?? null,
            serverNow,
            me: pos ? { lat: pos.lat, lon: pos.lon } : null,
            heading: sensors?.heading(now) ?? null,
            myNum: null,
            meLit: false,
            mates: input.mates ?? null,
            meAcc: pos?.acc ?? null,
            myKind: 'unknown',
            area: areaPts,
            jail: game.jail?.pts ?? null,
          });
        }
      }

      // ミッション
      const mission = game.mission ?? null;
      missionOpen = !!mission?.open;
      // 決めるための並びは、このラウンドの全部のミッションの写真（前のミッションの見ていない写真も押せるように）
      const roundPhotos = host.photos ?? [];
      const photos = roundPhotos.filter((ph) => ph.missionId === mission?.id);
      const okCount = photos.filter((ph) => ph.status === 'ok').length;
      const waitingCount = photos.filter((ph) => ph.status === 'pending').length;
      q('missionNow').textContent = mission
        ? `「${mission.title}」${mission.open ? '受け付け中' : '締め切った'}・届いた ${photos.length}枚・成功 ${okCount}枚${waitingCount ? `・見ていない ${waitingCount}枚` : ''}`
        : 'まだ出していない';
      const canIssue = game.stage !== 'ended';
      missionTitle.disabled = !canIssue;
      const go = q('missionGo') as HTMLButtonElement;
      go.disabled = !canIssue;
      go.textContent = mission?.open ? '次のミッションを出す' : 'ミッションを出す';
      q('missionClose').hidden = !mission?.open;
      const photoKey = JSON.stringify(roundPhotos.map((ph) => [ph.id, ph.status, ph.freed ?? 0]));
      if (photoKey !== lastPhotoKey) {
        lastPhotoKey = photoKey;
        // 見ていない写真を先に、そのあと新しい順
        const order = [...roundPhotos].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.at - a.at);
        q('photoGrid').replaceChildren(
          ...order.map((ph) =>
            photoFigure(
              ph.id,
              `${ph.name}・${clock(ph.at)}・${PHOTO_STATUS_NAME[ph.status]}${ph.freed ? `・牢屋から${ph.freed}人` : ''}`,
              ph.status,
              { id: ph.id },
            ),
          ),
        );
        // 全部の夜の一覧を開いている間に、写真が届いた・決めたら読み直す
        if (album.open) void showAlbum();
      }

      const namesKey = JSON.stringify([host.names ?? null, host.bans ?? null]);
      if (namesKey !== lastNamesKey) {
        lastNamesKey = namesKey;
        const names = host.names ?? [];
        q('names').hidden = !host.names;
        const flagged = names.filter((n) => n.hit || n.state !== 'ok');
        q('namesNow').textContent = flagged.length ? `気になる名前 ${flagged.length}` : '';
        const STATE: Record<string, string> = { due: '付け直し待ち', shamed: '切り替えた' };
        q('nameList').innerHTML = names.length
          ? names
              .map((n) => {
                const tag = n.hit ? `<em class="names-hit">「${esc(n.hit)}」に引っかかる</em>` : n.state !== 'ok' ? `<em>${STATE[n.state]}</em>` : '';
                const where = n.tonight ? '' : '<small>今夜いない</small>';
                const d = `data-pid="${esc(n.pid)}" data-name="${esc(n.name)}"`;
                const redo = n.state === 'due' ? '' : `<button type="button" ${d} data-nop="redo">付け直させる</button>`;
                const shame = n.state === 'shamed' ? '' : `<button type="button" ${d} data-nop="shame">切り替える</button>`;
                return `<div class="names-row${n.hit ? ' is-hit' : ''}"><span class="names-name">${esc(n.name)}${tag}${where}</span>${redo}${shame}</div>`;
              })
              .join('')
          : '<p class="note">今夜の人はまだいない</p>';
        const bans = host.bans ?? { custom: [], builtin: 0 };
        q('banSum').textContent = `名前に使えない言葉（最初から ${bans.builtin}・足した ${bans.custom.length}）`;
        q('banList').innerHTML = bans.custom
          .map((w) => `<button type="button" class="names-chip" data-word="${esc(w)}" aria-label="${esc(w)} を外す">${esc(w)} ×</button>`)
          .join('');
      }
      const dupKey = JSON.stringify(host.dupNames);
      if (dupKey !== lastDupKey) {
        lastDupKey = dupKey;
        const list = q('duplist');
        list.replaceChildren(
          ...host.dupNames.map((d) => {
            const row = document.createElement('div');
            row.className = 'dup-row';
            const label = document.createElement('span');
            label.textContent = `同じ名前「${d.name}」`;
            row.append(label);
            for (const p of d.people) {
              const b = document.createElement('button');
              b.type = 'button';
              b.dataset.pid = p.pid;
              const at = clock(p.joinedAt);
              b.dataset.label = `${d.name}（${at}に入った人）`;
              b.textContent = `${at}に入った人を外す`;
              row.append(b);
            }
            return row;
          }),
        );
      }
    },
  };
  return screen;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

function setEnabled(button: HTMLButtonElement, enabled: boolean, primary: boolean): void {
  button.disabled = !enabled;
  button.classList.toggle('primary', enabled && primary);
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 && s >= 60 ? `${s / 60}分` : `${s}秒`;
}

/** 夜を始めてからの長さ（「半日」「3日」など、ざっくり） */
function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 24) return `${Math.round(h)}時間`;
  return `${Math.round(h / 24)}日`;
}

/** 入った時刻（同じ名前の人を見分けるため） */
function clock(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
