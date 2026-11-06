/**
 * 試合中は画面を消さない（Screen Wake Lock）。
 *
 * iPhone は画面が消えた瞬間に WebSocket が閉じ、位置も届かなくなるので、試合中に画面が消えると
 * その人は「いない人」になる。ブラウザは裏に回ったときや電池が少ないときにロックを勝手に外すので、
 * 画面に戻るたび・画面に触れるたびに取り直す。
 *
 * - ホーム画面に追加したアプリ（iPhone）では iOS 18.4 から使える。それより古い端末は自動ロックを切ってもらう
 * - 使えない端末・断られたときは何もしない（ゲームはそのまま動く）
 */

export interface ScreenKeeper {
  /** 画面を消さないでほしいか。毎フレーム呼んでよい（変わったときだけ動く） */
  set(on: boolean): void;
  /** 今、実際に画面を消さないようにできているか */
  readonly held: boolean;
}

export function createScreenKeeper(): ScreenKeeper {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  let want = false;
  let sentinel: WakeLockSentinel | null = null;
  let pending = false;

  const acquire = async (): Promise<void> => {
    if (!supported || !want || sentinel || pending || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const s = await navigator.wakeLock.request('screen');
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
        // 裏に回って外れたときは、戻ったとき（visibilitychange）に取り直す
        if (want && document.visibilityState === 'visible') void acquire();
      });
      if (want) {
        sentinel = s;
      } else {
        void s.release().catch(() => undefined);
      }
    } catch {
      // 電池が少ない・裏にいる・操作の直後でない、などで断られた。次に戻ったとき・触れたときにまた試す
    } finally {
      pending = false;
    }
  };

  if (supported) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void acquire();
    });
    // 端末によっては、画面に触れた直後でないと許さない
    document.addEventListener('pointerdown', () => void acquire(), { passive: true });
  }

  return {
    set(on: boolean) {
      if (on === want) return;
      want = on;
      if (on) {
        void acquire();
      } else if (sentinel) {
        const s = sentinel;
        sentinel = null;
        void s.release().catch(() => undefined);
      }
    },
    get held() {
      return sentinel !== null;
    },
  };
}
