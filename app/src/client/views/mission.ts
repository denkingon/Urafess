import {
  PHOTO_LONG_EDGE,
  PHOTO_MAX_BYTES,
  PHOTO_PER_PERSON,
  PHOTO_QUALITY,
  PHOTO_STATUS_NAME,
  photosRevealed,
} from '../../shared/mission';
import { checkArea } from '../../shared/area';
import { inZone } from '../../shared/mission';
import type { GameView, MeView, MissionOk, MissionView } from '../../shared/protocol';
import { HOLD_MIN_MS } from '../../shared/rules';
import { bearingDeg, compassName, distanceText, type LatLon } from '../../shared/run';
import { formatClock } from '../../shared/schedule';

/**
 * ミッションの参加者の画面（見た目の層）。種類は3つ（集合写真・合流・範囲）で、札の形は同じ：
 * 題｜押すもの（写真を撮る・合流の長押し・残り時間）、その下に自分の状態と全体の状態。
 * - 集合写真：「写真を撮る」・自分の写真の状態・成功した人の名前（全員に見える）
 * - 合流：組の相手の名前と、2人で同時に押す「合流」の長押し。鬼には「誰と誰が合流しようとしているか」
 * - 範囲：集まる人数・残り時間・いま中にいる人数・自分が中か外か。範囲は全体の地図に蓄光の面で出る（鬼にも）
 * - 写真の並び（結果発表の間、真ん中）：成功した写真を全員に見せる
 */

export interface PhotoLoader {
  /** 写真を取り出して、画面で使える URL にする（一度取ったものは覚えておく）。見せてもらえないときは null */
  get(id: string): Promise<string | null>;
}

/** 取れなかった写真は、3秒・6秒・12秒…と間を空けて聞き直す。これだけ失敗したらあきらめる（無料枠を守る） */
const RETRY_BASE_MS = 3_000;
const RETRY_MAX = 6;

/**
 * 写真を取り出す。headers は主催者なら合言葉、参加者なら合い鍵。
 * keep＝覚えておく枚数（古いものから捨てる。捨てても表示中の写真は消えない）
 */
export function createPhotoLoader(gameId: string, headers: () => Record<string, string> | null, keep = 60): PhotoLoader {
  const done = new Map<string, string>();
  const busy = new Map<string, Promise<string | null>>();
  const failed = new Map<string, { n: number; at: number }>();
  return {
    get(id) {
      const have = done.get(id);
      if (have) {
        // 最近使った順に並べ直す
        done.delete(id);
        done.set(id, have);
        return Promise.resolve(have);
      }
      const going = busy.get(id);
      if (going) return going;
      const f = failed.get(id);
      if (f && (f.n >= RETRY_MAX || Date.now() - f.at < RETRY_BASE_MS * 2 ** (f.n - 1))) return Promise.resolve(null);
      const h = headers();
      if (!h) return Promise.resolve(null);
      const p = fetch(`/api/game/${gameId}/photo/${id}`, { headers: h })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const url = URL.createObjectURL(await res.blob());
          failed.delete(id);
          done.set(id, url);
          while (done.size > keep) {
            const [oldId, oldUrl] = done.entries().next().value as [string, string];
            done.delete(oldId);
            URL.revokeObjectURL(oldUrl);
          }
          return url;
        })
        .catch(() => {
          const prev = failed.get(id);
          failed.set(id, { n: (prev?.n ?? 0) + 1, at: Date.now() });
          return null;
        })
        .finally(() => busy.delete(id));
      busy.set(id, p);
      return p;
    },
  };
}

/** 撮った写真を縮めて JPEG にする（長い辺 PHOTO_LONG_EDGE、上限 PHOTO_MAX_BYTES に収まるまで小さくする） */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const img = await decode(file);
  try {
    for (const [edge, quality] of [
      [PHOTO_LONG_EDGE, PHOTO_QUALITY],
      [1280, 0.7],
      [1024, 0.6],
      [800, 0.55],
    ] as const) {
      const scale = Math.min(1, edge / Math.max(img.w, img.h));
      const w = Math.max(1, Math.round(img.w * scale));
      const h = Math.max(1, Math.round(img.h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.drawImage(img.src, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      canvas.width = canvas.height = 0;
      if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
    }
    throw new Error('too-big');
  } finally {
    img.close();
  }
}

async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // 写真の向き（スマホの縦横）を写真の情報どおりにする
      const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: b, w: b.width, h: b.height, close: () => b.close() };
    } catch {
      // 古いブラウザ：下の <img> で読む
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('decode');
  }
  return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

const UPLOAD_ERRORS: Record<string, string> = {
  closed: 'ミッションはもう締め切られた。',
  'too-many': `1つのミッションで送れるのは${PHOTO_PER_PERSON}枚まで。`,
  'too-big': '写真が大きすぎて送れなかった。もう一度撮る。',
  'not-jpeg': '写真を読めなかった。もう一度撮る。',
  'not-in': '今夜に入っていないので送れない。',
  full: '写真の置き場がいっぱい。主催者に知らせる。',
};

export interface MissionDeps {
  gameId: string;
  /** 合い鍵（名簿の人）。無ければ送れない */
  identity(): { pid: string; key: string } | null;
  serverNow(): number;
  /** 合流の長押し（押し始め・離した。時刻はスマホの時計） */
  meetStart?(localAt: number): void;
  meetEnd?(localAt: number): void;
  /** 自分の位置（範囲の中か外かを自分のスマホで見る）。取れていなければ null */
  position?(): LatLon | null;
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末
  }
}

/** 札に出す中身（種類ごとに組み立てる。見た目は同じ形） */
interface CardText {
  title: string;
  state: string;
  /** 右に出すもの：shoot＝写真を撮る、meet＝合流の長押し、clock＝残り時間、none＝何も */
  action: 'shoot' | 'meet' | 'clock' | 'none';
  clock: string;
  mine: string;
  mineState: string;
  ok: string;
}

/** 残り時間の字（締め切りなし・締め切ったあとは空。止めている間は「止」） */
function leftText(mission: MissionView, game: GameView, now: number): string {
  if (!mission.open || !mission.until) return '';
  if (game.timer?.status === 'paused') return '止';
  return formatClock(mission.until - now);
}

/** 合流の札 */
export function meetCard(mission: MissionView, game: GameView, me: MeView, now: number, holding: boolean): CardText {
  const meet = mission.meet;
  const my = me.meet && me.meet.missionId === mission.id ? me.meet : null;
  const clock = leftText(mission, game, now);
  const left = clock ? `（残り ${clock}）` : '';
  const done = mission.done ?? null;
  const base: CardText = { title: mission.title, state: mission.open ? '受け付け中' : '締め切った', action: 'none', clock, mine: '', mineState: '', ok: '' };
  // 全体の状態（全員に同じ。鬼にも見える）
  if (meet) {
    const one = meet.scope === 'one' ? meet.pairs?.[0] : undefined;
    if (one) {
      const who = one.names.join('と');
      base.ok = one.okAt !== null ? `成功：${who}が合流した${done?.freed ? `。牢屋から${done.freed}人出た` : ''}` : mission.open ? '' : `失敗：${who}は合流できなかった`;
    } else {
      base.ok = `合流した組 ${meet.ok}/${meet.groups}${!mission.open && done?.freed ? `。牢屋から${done.freed}人出た` : ''}`;
    }
  }
  if (my && me.role === 'runner') {
    const names = my.with.map((w) => w.name).join('・');
    base.title = `${names}と合流しろ`;
    if (my.okAt !== null) {
      base.mine = '合流した。成功。';
      base.mineState = 'ok';
    } else if (!mission.open) {
      base.mine = '締め切った。合流できなかった。';
      base.mineState = 'no';
    } else if (me.caught) {
      base.mine = '牢屋にいる間は合流できない。';
    } else if (my.with.length > 0 && my.with.every((w) => w.jailed)) {
      base.mine = `${names}は牢屋にいる。先に助ける。${left}`;
    } else {
      base.action = 'meet';
      base.mine = holding
        ? `${names}も同時に長押し。`
        : `${my.with.length > 1 ? 'どちらかと' : ''}2人で同時に長押し${left}`;
    }
    return base;
  }
  // 鬼・組に入っていない人：誰と誰が合流しようとしているか（札は1行なので短く）
  const pairs = meet?.pairs;
  const oni = me.role === 'oni';
  base.title =
    pairs && pairs.length === 1
      ? `${pairs[0].names.join('×')}${oni ? 'の合流を止めろ' : 'を合流させろ'}`
      : oni
        ? `合流を止めろ（${meet?.groups ?? 0}組）`
        : `仲間が合流しようとしている（${meet?.groups ?? 0}組）`;
  if (mission.open) {
    base.action = clock ? 'clock' : 'none';
    base.mine = oni
      ? pairs && pairs.length > 1
        ? pairs.filter((x) => x.okAt === null).map((x) => x.names.join('×')).join('、')
        : '2人が会う前に捕まえる。'
      : pairs && pairs.length === 1 && me.role === 'runner'
        ? '2人が会えるように助ける。'
        : '';
  }
  return base;
}

/** 範囲の札。pos＝自分の位置（取れていなければ null） */
export function zoneCard(mission: MissionView, game: GameView, me: MeView, now: number, pos: LatLon | null): CardText {
  const zone = mission.zone!;
  const clock = leftText(mission, game, now);
  const done = mission.done ?? null;
  const base: CardText = {
    title: `範囲に${zone.need}人集まれ`,
    state: mission.open ? '受け付け中' : '締め切った',
    action: mission.open ? 'clock' : 'none',
    clock,
    mine: '',
    mineState: '',
    ok: '',
  };
  if (!mission.open) {
    if (!done) base.ok = '締め切った（判定なし）。';
    else if (done.ok) {
      base.mine = `成功：${done.count}人が集まった${done.freed ? `。牢屋から${done.freed}人出た` : ''}`;
      base.mineState = 'ok';
    } else {
      base.mine = `失敗：集まったのは${done.count}/${zone.need}人`;
      base.mineState = 'no';
    }
    return base;
  }
  let self = '';
  if (me.role === 'runner' && !me.caught) {
    if (!pos) self = '・地図の光る枠へ';
    else if (inZone(zone.pts, pos)) self = '・自分は中';
    else {
      const c = checkArea(zone.pts, pos);
      self = `・自分は外（${compassName(bearingDeg(pos, c.nearest))} ${distanceText(c.edgeM)}）`;
    }
  } else if (me.role === 'runner') {
    self = '・牢屋の人は数えない';
  } else if (me.role === 'oni') {
    self = '・地図の光る枠';
  }
  // 試合を止めている間は位置が届かないので、人数は出さない（締め切りも止まっている）
  base.mine = clock === '止' ? '試合を止めている。締め切りも止まっている。' : `いま中に ${zone.now ?? 0}/${zone.need}人${self}`;
  return base;
}

export interface MissionScreen {
  /** 長押しの上に置く札 */
  card: HTMLElement;
  /** 結果発表の間、真ん中に置く写真の並び */
  gallery: HTMLElement;
  update(game: GameView | null, me: MeView | null): void;
}

export function createMission(deps: MissionDeps): MissionScreen {
  const card = document.createElement('section');
  card.className = 'mission-card';
  card.hidden = true;
  card.innerHTML = `
    <div class="mission-head"><span class="mission-tag">ミッション</span><span class="mission-state" data-k="state"></span></div>
    <div class="mission-title" data-k="title"></div>
    <button type="button" class="primary mission-shoot" data-k="shoot">写真を撮る</button>
    <button type="button" class="mission-meet" data-k="meet" hidden><span class="mission-meet-fill"></span><b data-k="meetLabel">合流</b></button>
    <div class="mission-clock u" data-k="clock" hidden></div>
    <input type="file" accept="image/*" capture="environment" data-k="file" hidden>
    <p class="mission-mine" data-k="mine" aria-live="polite"></p>
    <p class="mission-ok" data-k="ok" aria-live="polite"></p>
  `;
  const gallery = document.createElement('section');
  gallery.className = 'mission-gallery';
  gallery.hidden = true;
  const q = (k: string) => card.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const shoot = q('shoot') as HTMLButtonElement;
  const file = q('file') as HTMLInputElement;
  const loader = createPhotoLoader(deps.gameId, () => {
    const id = deps.identity();
    return id ? { 'x-pid': id.pid, 'x-key': id.key } : null;
  });

  /** 送っている途中（サーバーから「受け取った」が返るまで） */
  let sending = false;
  let error: string | null = null;
  let missionId: number | null = null;
  let last = '';
  let lastGallery = '';

  // 合流の長押し（牢屋の「助ける」と同じ押し方：HOLD_MIN_MS 押し続けたら送り、離したら終わり）
  const meetBtn = q('meet') as HTMLButtonElement;
  let pressing: { id: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let holding = false;
  const endPress = () => {
    if (!pressing) return;
    clearTimeout(pressing.timer);
    pressing = null;
    if (holding) {
      holding = false;
      deps.meetEnd?.(Date.now());
    }
    card.classList.remove('is-pressing', 'is-holding');
    last = '';
  };
  meetBtn.addEventListener('pointerdown', (e) => {
    if (meetBtn.hidden || pressing) return;
    e.preventDefault();
    try {
      meetBtn.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動く
    }
    pressing = {
      id: e.pointerId,
      at: Date.now(),
      timer: setTimeout(() => {
        if (!pressing) return;
        holding = true;
        card.classList.add('is-holding');
        deps.meetStart?.(pressing.at);
        vibrate(20);
        last = '';
      }, HOLD_MIN_MS),
    };
    card.classList.add('is-pressing');
  });
  const release = (e: PointerEvent) => {
    if (pressing && e.pointerId === pressing.id) endPress();
  };
  meetBtn.addEventListener('pointerup', release);
  meetBtn.addEventListener('pointercancel', release);
  meetBtn.addEventListener('lostpointercapture', release);
  meetBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  /** 震わせるのは変わった瞬間だけ：自分の組が合流した・ミッションの結果が出た */
  let seen: { id: number; met: boolean; done: boolean } | null = null;

  shoot.addEventListener('click', () => {
    error = null;
    file.value = '';
    file.click();
  });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    const id = deps.identity();
    const m = missionId;
    if (!f || !id) return;
    if (m === null) {
      // カメラを開いている間に締め切られた
      error = UPLOAD_ERRORS.closed;
      last = '';
      return;
    }
    sending = true;
    error = null;
    last = '';
    void (async () => {
      try {
        const blob = await shrinkPhoto(f);
        const res = await fetch(`/api/game/${deps.gameId}/photo?m=${m}`, {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg', 'x-pid': id.pid, 'x-key': id.key },
          body: blob,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          error = UPLOAD_ERRORS[body.error ?? ''] ?? '送れなかった。電波を確かめて、もう一度撮る。';
        }
      } catch (e) {
        error = (e as Error).message === 'too-big' ? UPLOAD_ERRORS['too-big'] : '送れなかった。電波を確かめて、もう一度撮る。';
      } finally {
        sending = false;
        last = '';
      }
    })();
  });

  /** 並びを作るのは写真の顔ぶれが変わったときだけ。画像は loader が間を空けて取りに行く */
  function renderGallery(list: MissionOk[], title: string): void {
    const key = JSON.stringify([list.map((x) => x.id), title]);
    if (key === lastGallery) {
      for (const img of gallery.querySelectorAll<HTMLImageElement>('img[data-id]:not([src])')) fill(img);
      return;
    }
    lastGallery = key;
    gallery.replaceChildren();
    if (!list.length) return;
    const head = document.createElement('div');
    head.className = 'mission-gallery-head';
    head.textContent = `ミッション「${title}」の写真`;
    const strip = document.createElement('div');
    strip.className = 'mission-strip';
    for (const ph of list) {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.alt = `${ph.name}が送った写真`;
      img.decoding = 'async';
      img.dataset.id = ph.id;
      const cap = document.createElement('figcaption');
      cap.textContent = ph.name;
      fig.append(img, cap);
      strip.append(fig);
      fill(img);
    }
    gallery.append(head, strip);
  }

  /** 画像を入れる。取れなければ src は空のまま（次の update でまた頼む。loader が間を空ける） */
  function fill(img: HTMLImageElement): void {
    if (img.dataset.loading) return;
    img.dataset.loading = '1';
    void loader.get(img.dataset.id!).then((url) => {
      delete img.dataset.loading;
      if (url) img.src = url;
    });
  }

  return {
    card,
    gallery,
    update(game, me) {
      const mission = game?.mission ?? null;
      const ended = game?.stage === 'ended';
      card.hidden = !mission || ended || !me || me.removed;
      const kind = mission?.kind ?? 'photo';
      missionId = mission?.open && kind === 'photo' ? mission.id : null;
      const okList = (game?.missionOk ?? []).filter((x) => x.missionId === mission?.id);
      const revealed = !!game && !!mission && !ended && photosRevealed(game, deps.serverNow());
      gallery.hidden = !revealed || okList.length === 0;
      if (!gallery.hidden && mission) renderGallery(okList, mission.title);
      if (card.hidden || !mission || !me) {
        endPress();
        return;
      }
      card.dataset.kind = kind;
      if (kind !== 'photo' && game) {
        const now = deps.serverNow();
        const text =
          kind === 'zone' && mission.zone
            ? zoneCard(mission, game, me, now, deps.position?.() ?? null)
            : meetCard(mission, game, me, now, holding);
        // 変わった瞬間に震わせる（開いたときにもう決まっていた分は震わせない）
        const met = !!me.meet && me.meet.missionId === mission.id && me.meet.okAt !== null;
        const done = !!mission.done;
        if (seen && seen.id === mission.id) {
          if (met && !seen.met) vibrate([60, 40, 60, 40, 120]);
          else if (done && !seen.done) vibrate(mission.done?.ok ? [60, 40, 60, 40, 120] : [200]);
        } else if (mission.open) {
          vibrate([80, 60, 80]);
        }
        seen = { id: mission.id, met, done };
        if (text.action !== 'meet') endPress();
        const key = JSON.stringify(text);
        if (key === last) return;
        last = key;
        q('title').textContent = text.title;
        q('state').textContent = text.state;
        shoot.hidden = true;
        meetBtn.hidden = text.action !== 'meet';
        q('meetLabel').textContent = holding ? '待っている…' : '合流';
        const clockEl = q('clock');
        clockEl.hidden = text.action !== 'clock' || !text.clock;
        clockEl.textContent = text.clock;
        q('mine').textContent = text.mine;
        q('mine').dataset.state = text.mineState;
        q('ok').textContent = text.ok;
        return;
      }
      endPress();
      meetBtn.hidden = true;
      q('clock').hidden = true;

      const mine = (me.sent ?? []).filter((x) => x.missionId === mission.id);
      const latest = mine[mine.length - 1] ?? null;
      const key = JSON.stringify([mission, mine, okList.map((x) => [x.name, x.freed ?? 0]), sending, error, revealed]);
      if (key === last) return;
      last = key;
      q('title').textContent = mission.title;
      q('state').textContent = mission.open ? '受け付け中' : '締め切った';
      const canSend = mission.open && !sending && mine.length < PHOTO_PER_PERSON && latest?.status !== 'ok';
      shoot.hidden = !mission.open || latest?.status === 'ok';
      shoot.disabled = !canSend;
      shoot.textContent = sending ? '送っている…' : latest && latest.status === 'no' ? 'もう一度撮る' : latest ? 'もう1枚撮る' : '写真を撮る';
      const mineText = error
        ? error
        : sending
          ? '写真を送っている。'
          : latest
            ? latest.status === 'ok'
              ? '成功。'
              : latest.status === 'no'
                ? 'やり直し。撮り直して送る。'
                : `${PHOTO_STATUS_NAME.pending}。`
            : '';
      q('mine').textContent = mineText;
      q('mine').dataset.state = error ? 'error' : latest?.status ?? '';
      const names = [...new Set(okList.map((x) => x.name))];
      const freed = okList.reduce((sum, x) => sum + (x.freed ?? 0), 0);
      q('ok').textContent = names.length
        ? `成功：${names.join('・')}${freed ? `。牢屋から${freed}人出た` : ''}${revealed ? '' : '（写真は結果発表で出る）'}`
        : mission.open
          ? ''
          : 'まだ誰も成功していない。';
    },
  };
}
