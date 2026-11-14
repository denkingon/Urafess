import { handleProbe } from './probe';
import { GAME_PATH, type Env } from './room';

export { ProbeHub } from './probe';
export { GameRoom } from './room';

/**
 * /api/game/<ゲームID>/ws    … 参加者・主催者がつなぐ WebSocket
 * /api/game/<ゲームID>/key   … 主催者の合言葉が合っているかだけを答える（204 か 403）
 * /api/game/<ゲームID>/debug … 主催者の合言葉つきで、全員の役を含む中身を見る
 * /api/game/<ゲームID>/log   … 主催者の合言葉つきで、1イベント＝1行の記録を CSV（?format=json で JSON）で書き出す
 * /api/game/<ゲームID>/photo … ミッションの写真を送る（POST）・/photo/<印> で取り出す（GET）
 * /api/game/<ゲームID>/photos … 主催者の合言葉つきで、全部の夜の写真の一覧
 * /api/game/<ゲームID>/me    … 自分のページ（本人の合い鍵つきで記録を見る・名前を変える・新しいスマホへ移す・名簿から消える）
 * /api/probe…                 … 夜テスト（位置・往復・回線・接続の切れ目を記録する画面と、その集計）
 * それ以外は画面（静的ファイル）。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(GAME_PATH);
    if (m) {
      // ゲームの部屋は最初に作られた場所から動かないので、日本を含む北東アジアに作る
      const stub = env.GAME.get(env.GAME.idFromName(m[1]), { locationHint: 'apac-ne' });
      return stub.fetch(request);
    }
    if (url.pathname === '/api/probe' || url.pathname.startsWith('/api/probe/')) return handleProbe(request, env, url);
    if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
