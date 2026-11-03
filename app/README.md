# Urafess アプリの土台

入室・①配役（鬼3：逃走者7）・②同期タイマーだけを、300人で崩れないように作ったもの。

- 計画書（正本）：[Urafess アプリ根幹 計画書](https://claude.ai/artifact/7ouAiRxriSSYHpYCdgGRm5)
- 画面の下書き：[Urafess アプリ画面（Claude Design）](https://claude.ai/artifact/9RCkDqT7CL9dtifftVs1SY)

1ラウンドは「配役 → 逃走開始まで20秒 → 追跡開始まで1分 → ゲーム5分 → 広場に戻る2分 → 結果発表」。
主催者が「開始」を押すと、サーバーが区切りの時刻をすべて決めて全員に送り、各スマホはその時刻が来たら自分で次の段階に切り替わる。

## 構成

| 場所 | 中身 |
| --- | --- |
| `src/shared/` | 決まりごと（`rules.ts`）、配役の計算（`allocate.ts`）、区切りの計算（`schedule.ts`）、時計合わせ（`clock.ts`）、画面に渡す中身（`viewmodel.ts`） |
| `src/server/` | Cloudflare Worker と Durable Object（1ゲーム＝1つ、SQLite に保存してから配る） |
| `src/client/core/` | しくみ：接続・つなぎ直し・時計合わせ・状態（見た目を知らない） |
| `src/client/views/` と `styles.css` | 見た目：キャンバスの Phone を写した仮の白黒。差し替えるのはここだけ |
| `test/` | 単体テスト（配役は1〜300人を全部確かめる） |
| `sim/` | 300人の機械テスト。結果は `sim/last-report-300.md` |

安定性の芯は3つ。

1. 正解はサーバーの1か所（Durable Object）だけが持つ。操作は1つずつ順番に処理し、保存してから配る
2. つながるたびに「今の全部」を送る。取りこぼしても、次につながった瞬間に正しい状態に戻る
3. タイマーは数えない。区切りの時刻から毎回計算する（裏に回っても、切れても、ずれが溜まらない）

## 見た目を差し替えるとき

しくみは `PhoneView`（`src/shared/viewmodel.ts`）だけを画面に渡す。中身はキャンバスの共通部品 Phone の props と同じ：
`round`・`role`（逃走者／鬼／なし）・`step`（0〜6）・`label`・`big`・`message`・`oni`・`runners`・`offline`。
新しい見た目は `src/client/views/phone.ts` と `styles.css` を差し替えて、これを描けばいい。主催者画面は `views/host.ts`。

## 手元で動かす

```sh
cd app
npm install
echo 'HOST_TOKEN=好きな合言葉' > .dev.vars
npm run dev
```

- 参加者：http://localhost:8787/
- 主催者：http://localhost:8787/host?token=好きな合言葉（初回だけ。端末が覚えて URL からは消える）
- 別のゲームにするとき：`?g=名前`（例 `?g=2026-12-05`。主催者も同じ `?g=` で開く）

## テスト

```sh
npm run typecheck   # 型
npm test            # 単体テスト
npm run sim         # 300人の機械テスト（SIM_N=50 npm run sim で人数を変えられる）
```

機械テストは、本物のサーバー（wrangler dev）に、ブラウザと同じしくみで仮想参加者300人をつなぎ、
回線の遅れ（行きと帰りで別々・ときどき1.5〜3秒の詰まり）、突然の切断、スマホの時計のずれ（±5分）、
2人の主催者の同時押し、同じ名前の二重入室、試合中のサーバー再起動、一時停止と再開を混ぜて2ラウンド回す。

## 公開する

Cloudflare のアカウント（無料）が要る。

```sh
cd app
npx wrangler login                 # もしくは CLOUDFLARE_API_TOKEN を環境変数に入れる
npx wrangler secret put HOST_TOKEN # 主催者用の合言葉
npm run deploy
```

公開先は `https://urafess.<アカウントのサブドメイン>.workers.dev`。

- 参加者に配るのはトップの URL。LINE で配るときは末尾に `?openExternalBrowser=1` を付ける（LINE の中のブラウザで開かせない）
- 参加者には前もってホーム画面に追加してもらう（当日の読み込みが通信に頼らなくなる）。iPhone はホーム画面のアプリと Safari で保存場所が別なので、入室は当日ホーム画面のアプリの中で行う
- ゲームの部屋は日本を含む北東アジア（`apac-ne`）に作られる

## 本番の日

やらないこと

- `npm run deploy`（更新の公開）をしない。サーバーが入れ替わり、全員の接続が一度切れる（つなぎ直せば元に戻るが、わざわざ起こさない）
- 試合中にゲーム名（`?g=`）を変えない

やること

- 昼のうちに、公開済みのアプリで1ラウンド通す
- 開始の前に、主催者画面の「役の受け取り」が全員分そろい、「時計が合っている」がほぼ全員になったのを見る
- Cloudflare 自体が止まったときのために、ストップウォッチと口頭の配役で回す手順を紙で持っておく

## 無料枠

Durable Objects の無料プランは1日10万リクエスト。スマホから届く WebSocket のメッセージは20通で1リクエストと数え、送る側は無料
（[料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。300人が30秒ごとに時計を合わせても、2時間で約3,600リクエスト。
