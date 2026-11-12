import { createOverview } from './overview';

/**
 * 背景の地図（試作。URL に ?bg=map をつけたときだけ）。
 * 参加者の画面（入室・待合室・配役・カウント・ゲーム・結果）の後ろに、全体の地図と同じ SFC の下地を敷く。
 * 画面より大きく敷いて（縦いっぱい・横ははみ出す）、キャンパスが画面を埋めるようにする。人の点は置かない（下地だけ）。
 * いまは全体の地図と同じく OpenStreetMap の画像をその場で読む。本番にするなら、1枚の絵にしてアプリに入れる（電波が無くても出る）
 */
export function mountBackdrop(): void {
  if (document.querySelector('.backdrop')) return;
  const el = document.createElement('div');
  el.className = 'backdrop';
  el.setAttribute('aria-hidden', 'true');
  const frame = document.createElement('div');
  frame.className = 'backdrop-map';
  const ov = createOverview();
  frame.append(ov.el);
  const credit = document.createElement('a');
  credit.className = 'backdrop-credit';
  credit.href = 'https://www.openstreetmap.org/copyright';
  credit.target = '_blank';
  credit.rel = 'noopener';
  credit.textContent = '© OpenStreetMap';
  el.append(frame);
  document.body.prepend(el);
  document.body.append(credit);
  document.body.classList.add('has-backdrop');
  const draw = () => ov.update({ me: null, meKind: 'unknown', meLit: false, points: [], labelMax: 0, frameBase: 'campus' });
  draw();
  requestAnimationFrame(draw);
}
