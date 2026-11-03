# URAJI（裏字）

裏フェスの書体。どの字にも、字の高さの 0.618 に一本の線（切れ目）が走る。線より上が表、下が裏。

- 使い方・色・組み方のルール：[裏フェス フォント（デザインシステム）](https://claude.ai/artifact/51KpKXTyAqecGQS2kp2hRK)
- 形を動かして決める：[URAJI つまみ](https://claude.ai/artifact/FabYiinMDhuPoC8WHhADeW)（`tool/knobs.html` と同じもの）
- 光でつくる見せ方の試作：[URAJI 光の字](https://claude.ai/artifact/AJfsz5zmbwquiHFTb3dHfb)（`tool/light.html` と同じもの）

## ファイル

| ファイル | 中身 |
| --- | --- |
| `URAJI-Black.otf` | Figma・Canva・Illustrator・動画編集ソフトに入れる |
| `URAJI-Black.woff2` | ウェブ（アプリ）で読み込む |
| `src/glyphs.js` | 字形の正本（英数字・記号・裏）。全字をつまみ（`DEFAULTS`）から組み立てる |
| `src/kana.js` | 字形の正本（カタカナ） |
| `src/export.js` → `src/build.py` | 字形を演算の木として書き出し、pathops で OTF・WOFF2 にする |
| `tool/` | つまみの道具と光の字のページ。同じ正本を読むので、道具で見た形とフォントの形は一致する |
| `build.sh` | 全部を作り直す |

## 文字セット（v0.2）

英字 A–Z（小文字を打っても大文字が出る）、数字 0–9（等幅）、記号 `. , : ; ! ? - – — ' " ( ) / + = × # ·`、矢印 `→ ← ↑ ↓`、カタカナ全部（小さいかな・濁点・半濁点・ヴ）、`ー ・ 「 」 、 。`、漢字は「裏」だけ。ひらがなは入っていない。

`font-feature-settings: "ss01"`（型紙セット）で、閉じた穴が残る B・6・8・裏・パ行・。にも短い切れ目が入り、全字が一枚の板から切り抜ける。

## 作り直す

```sh
pip install -r requirements.txt   # fonttools, skia-pathops, brotli（Node も使う）
./build.sh                        # src/glyphs.js の DEFAULTS の値で作る
./build.sh try.json               # つまみの値を試す（例: {"SLIT":0.6,"T":44}）
```

つまみの道具で「この値で決める」を押した値は、`src/glyphs.js` の `DEFAULTS` に書き写してから `./build.sh` を回す。字ごとに手で直さない。
