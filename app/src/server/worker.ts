import type { Env } from './room';

export { GameRoom } from './room';

/**
 * /api/game/<ゲームID>/ws    … 参加者・主催者がつなぐ WebSocket
 * /api/game/<ゲームID>/debug … 主催者の合言葉つきで、全員の役を含む中身を見る
 * それ以外は画面（静的ファイル）。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/game\/([A-Za-z0-9_-]{1,40})\/(ws|debug)$/);
    if (m) {
      // ゲームの部屋は最初に作られた場所から動かないので、日本を含む北東アジアに作る
      const stub = env.GAME.get(env.GAME.idFromName(m[1]), { locationHint: 'apac-ne' });
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
