import {
  PHOTO_LONG_EDGE,
  PHOTO_MAX_BYTES,
  PHOTO_PER_PERSON,
  PHOTO_QUALITY,
  PHOTO_STATUS_NAME,
  photosRevealed,
} from '../../shared/mission';
import type { GameView, MeView, MissionOk } from '../../shared/protocol';

/**
 * ミッション（集合写真）の参加者の画面（見た目の層）。
 * - 札（長押しの上）：ミッションの題・「写真を撮る」・自分の写真の状態・成功した人の名前（全員に見える）
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
  card.className = 'mission';
  card.hidden = true;
  card.innerHTML = `
    <div class="mission-head"><span class="mission-tag">ミッション</span><span class="mission-state" data-k="state"></span></div>
    <div class="mission-title" data-k="title"></div>
    <button type="button" class="primary mission-shoot" data-k="shoot">写真を撮る</button>
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
      missionId = mission?.open ? mission.id : null;
      const okList = (game?.missionOk ?? []).filter((x) => x.missionId === mission?.id);
      const revealed = !!game && !!mission && !ended && photosRevealed(game, deps.serverNow());
      gallery.hidden = !revealed || okList.length === 0;
      if (!gallery.hidden && mission) renderGallery(okList, mission.title);
      if (card.hidden || !mission || !me) return;

      const mine = (me.sent ?? []).filter((x) => x.missionId === mission.id);
      const latest = mine[mine.length - 1] ?? null;
      const key = JSON.stringify([mission, mine, okList.map((x) => x.name), sending, error, revealed]);
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
      q('ok').textContent = names.length
        ? `成功：${names.join('・')}${revealed ? '' : '（写真は結果発表で出る）'}`
        : mission.open
          ? ''
          : 'まだ誰も成功していない。';
    },
  };
}
