# Voice2QR 導入手順書

ソースからビルドして、静的サイトとして配置するまでの手順。
Voice2QR はサーバ側の処理を持たない。ビルド成果物（`web/site/`）を
静的ホスティングに置くだけで動く。

## 1. 前提ツール

| ツール | 用途 |
|---|---|
| Rust（cargo）＋ `wasm32-unknown-unknown` ターゲット | コアの wasm ビルド |
| Emscripten（`emcc`） | Codec2 の wasm ビルド |
| Node.js 20 以上＋ npm | JS ライブラリと Web アプリのビルド |
| cmake / curl / sha256sum | Codec2 のソースビルド |

Rust のターゲット追加：

```sh
rustup target add wasm32-unknown-unknown
```

## 2. ビルド

リポジトリのルートで、上から順に実行する。

```sh
# (1) Codec2 1.2.0 を wasm にする（取得した tarball は SHA-256 で検証される）
codec2/build-wasm.sh        # -> codec2/out/codec2.wasm
#   ※ 実行権限がない環境では: sh codec2/build-wasm.sh

# (2) コアを wasm にする
cargo build --manifest-path core/Cargo.toml \
    --target wasm32-unknown-unknown --release
#   -> core/target/wasm32-unknown-unknown/release/voice2qr_core.wasm

# (3) JS ライブラリと Web アプリをビルドする
cd web
npm ci
npm run build               # ライブラリ -> web/dist/
npm test                    # ライブラリのテスト（任意だが推奨）
npm run build:app           # アプリ＋サイト組立 -> web/site/
cd ..
```

`web/site/` が配置用の成果物一式になる。中身の要点：

- `index.html` と `assets/` — アプリ本体
- `lib/v1/` — JS ライブラリ一式と wasm 3点
  （`voice2qr_core.wasm` / `codec2.wasm` / `zxing_reader.wasm`）。
  アプリはこれを実行時に相対パスで読み込む
- `worklet.js` / `sw.js` / `manifest.webmanifest` / `icon-*.png`

CI（`.github/workflows/ci.yml` の web ジョブ）も同じ手順を回して
検証している。

## 3. 配置

`web/site/` の**中身**を、静的ファイルとして配信できる場所に置く。
サブパスへの配置でもよい（全ての参照が相対パスになっている）。

条件はひとつだけ：

- **HTTPS（または localhost）で配信すること。**
  マイクとカメラ（`getUserMedia`）は secure context でなければ
  ブラウザが許可しない。`http://` の一般のホスト名では録音・
  カメラ読み取りが動かない。

Web サーバ側に特別な設定は要らない。`.wasm` が
`application/wasm` で配信されなくても読み込みは動作する
（ライブラリはバイト列として取得してからコンパイルする）。

## 4. 動作確認

1. ページを開き、「よむ」タブで QR 画像を選んで読み取れること
2. 「つくる」タブで録音し、QR が表示され、再生プレビューで
   自分の声が聞こえること

## 5. トラブルシューティング

**ページは表示されるのに、ボタンが何も反応しない**

- **ビルド前のソースを置いている**可能性が最も高い。
  リポジトリの `web/` フォルダそのもの（`index.html` が
  `./app/main.ts` を読み込む形）はブラウザでは動かない。
  必ず §2 の手順でビルドした `web/site/` の中身を配置すること。
- ブラウザの開発者コンソールで `lib/v1/index.js` の 404 が
  出ていないか確認する。`lib/v1/` ごとコピーできているか。
- 配置し直したのに古い表示のままなら、Service Worker の
  キャッシュではなく通常の HTTP キャッシュのことが多い。
  ハードリロード（Ctrl+Shift+R）で確認する。

**録音ボタンでマイクが起動しない／カメラが開かない**

- 配信が HTTPS か localhost かを確認する（§3）。
  ブラウザの仕様で、それ以外では端末が使えない。

**録音はできるが QR が出ない**

- コンソールに wasm の読み込みエラーがないか確認する。
  `lib/v1/` の wasm 3点が揃っているかを見ること。
