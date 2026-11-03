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

### 公開先で試す

本番の部屋 `main` とは別の部屋（`LIVE_GAME`）を使う。

```sh
LIVE_URL=https://urafess.denkingon.workers.dev LIVE_GAME=test-1 LIVE_N=200 \
  npx vitest run --config vitest.sim.config.ts sim/live.test.ts
```

- 仮想参加者がつないで待つ。主催者画面（`/host?g=test-1`）で「時間の設定」→「配役」→「開始」→勝ちを押すと、
  全員が役を受け取ったか・区切りの時刻がそろったか・時計の見積もりが理屈どおりか・他人の役が漏れていないかを記録する
  （途中経過は `sim/live-progress.log`、結果は `sim/live-report-<人数>.md`）
- `sim/diag.test.ts`：入室したまま放っておき、切れた接続を「回線側が閉じた／アプリが自分で切った」に分けて記録する
- `sim/ws-compare.mjs`：軽い接続だけを張り、切れた本数と往復時間を見る
- Claude のクラウドの作業用の機械から試すときは200人以下で。300本前後から、その機械の出口の都合で接続が切れて結果が濁る
  （2026-11-04 の記録：`sim/live-findings.md`）

## 公開する

Cloudflare（無料プラン）の Worker をこの GitHub リポジトリにつないである。**main に入った変更は自動でビルドされ、そのまま公開される**（Workers Builds）。
ビルドの成否は、GitHub のコミットの横のチェック（Cloudflare の check run）でも見られる。

Cloudflare 側の設定（Worker → Settings → Build）

| 項目 | 値 |
| --- | --- |
| Worker 名 | `urafess` |
| Root directory | `app`（アプリはこのフォルダにある。空だとビルドが失敗する） |
| Build command | `npm run build`（空でも `wrangler deploy` が先にビルドする） |
| Deploy command | `npx wrangler deploy` |
| プレビューコマンド（main 以外のブランチ。設定の「プレビューのベース」側） | `npx wrangler deploy --dry-run`（公開はせず、ビルドと組み立てが通るかだけ確かめる。初期値の `npx wrangler preview` は Durable Object を使うこのアプリでは設定が足りず失敗する） |

主催者用の合言葉は、Worker → Settings → Variables and Secrets に、種類 **Secret**・名前 `HOST_TOKEN` で入れる（作成画面の「Variables」はビルド用なので違う）。
入れるまでは主催者画面が「拒否」になるだけで、参加者側は動く。

手元から直接公開するとき（予備）：

```sh
cd app
npx wrangler login                 # もしくは CLOUDFLARE_API_TOKEN を環境変数に入れる
npx wrangler secret put HOST_TOKEN # 主催者用の合言葉
npm run deploy                     # 画面のビルドも中でやる
```

公開先は `https://urafess.<アカウントのサブドメイン>.workers.dev`。

- 参加者に配るのはトップの URL。LINE で配るときは末尾に `?openExternalBrowser=1` を付ける（LINE の中のブラウザで開かせない）
- 参加者には前もってホーム画面に追加してもらう（当日の読み込みが通信に頼らなくなる）。iPhone はホーム画面のアプリと Safari で保存場所が別なので、入室は当日ホーム画面のアプリの中で行う
- ゲームの部屋は日本を含む北東アジア（`apac-ne`）に作られる

## 本番の日

やらないこと

- main にマージ・push しない（＝自動で公開される）。手元からの `npm run deploy` もしない。公開するとサーバーが入れ替わり、全員の接続が一度切れる（つなぎ直せば元に戻るが、わざわざ起こさない）。前日のうちに Cloudflare 側で自動ビルドを止めておくと安心
- 試合中にゲーム名（`?g=`）を変えない

やること

- 昼のうちに、公開済みのアプリで1ラウンド通す
- 開始の前に、主催者画面の「役の受け取り」が全員分そろい、「時計が合っている」がほぼ全員になったのを見る
- Cloudflare 自体が止まったときのために、ストップウォッチと口頭の配役で回す手順を紙で持っておく

## 無料枠

Durable Objects の無料プランは1日10万リクエスト。スマホから届く WebSocket のメッセージは20通で1リクエストと数え、送る側は無料
（[料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。300人が30秒ごとに時計を合わせても、2時間で約3,600リクエスト。
