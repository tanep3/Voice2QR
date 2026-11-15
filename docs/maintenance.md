# Voice2QR メンテナンスノート

保守担当者向けの覚え書き。利用者向けの導入手順は `deployment.md`、
API の使い方は `api-reference.md` を見ること。

## バージョン番号の規則（最重要・リリースのたびに確認）

**バージョン番号の正は GitHub のリリースタグ `vX.Y.Z`。
`web/package.json` の `"appVersion"` は、タグから `v` を除いた文字列と
必ず一致させる。**

リリースの順序（順序を間違えると更新検出が壊れる）：

1. `web/package.json` の `appVersion` を、次のタグに合わせて上げる
2. ビルドする（`web/` で `npm run build` と `npm run build:app`）
3. 成果物を確認する：
   - `web/site/version.json` の中身が新しいバージョンであること
   - `web/site/sw.js` に `__APP_VERSION__` が残っていないこと
     （残っていたら刻印が失敗している）
4. 変更をまとめて push する
5. **そのコミットに**タグ `vX.Y.Z` を打つ
6. リリースを公開する（GitHub Pages のデプロイはタグで起動する）

なぜ順序が大事か：Pages のビルドはタグの付いたコミットから走る。
`appVersion` を上げる前にタグを打つと、配布されるアプリが古い
バージョンを自己申告し、`version.json` と食い違って、利用者側の
自動更新が正しく働かなくなる。

## バージョン埋め込みの仕組み（キャッシュ対策）

静的ホスティングではサーバ側でキャッシュを制御できない。対策なし
だと、Service Worker が cache-first で旧リリースを配信し続け、
利用者がいつまでも古いアプリを使い続ける事故になる。そのための
仕掛けがこれで、**壊すと事故が再発するので、変更時は全体を
見直すこと**。

埋め込みの経路（`appVersion` が唯一の入力）：

- `web/vite.config.ts`：`appVersion` を `__APP_VERSION__` として
  アプリ本体に注入する（アプリが自分のバージョンを知る手段）
- `web/scripts/assemble-site.mjs`：`site/sw.js` 内の
  `__APP_VERSION__` を置換し（キャッシュ名が `voice2qr-X.Y.Z` に
  なる）、`site/version.json` を生成する。プレースホルダが
  見つからなければビルドは失敗する（意図的な安全装置）

更新が伝わる流れ：

1. リリースで sw.js のバイト列が変わる → ブラウザが次回アクセス
   時に Service Worker の更新を検出する
2. 新しい Worker が新しいキャッシュを作り、activate で旧
   キャッシュが削除される
3. 保険として、アプリは起動時に `version.json` を `no-store` で
   取得し、自分の `__APP_VERSION__` と比べる。違えばキャッシュ
   全消去＋Worker 登録解除＋1回だけ再読み込みする
   （`sessionStorage` の印でループは防止済み。`version.json` は
   sw.js が横取りしない）
4. HTML（ナビゲーション）は network-first で、キャッシュは
   オフライン時の予備

触るときの注意：

- `web/public/sw.js` の `__APP_VERSION__` プレースホルダを消さない
- キャッシュ名の形式（`voice2qr-<version>`）を変える場合は、
  `version.json` の形式とアプリ側の比較処理も合わせて見直す
- **キャッシュの削除は `voice2qr-` 接頭辞のものだけに限る**
  （sw.js の activate と、アプリ側の更新チェックの両方）。
  Cache Storage は Service Worker のスコープではなく
  **オリジン単位**で共有される。同じホストで公開している他の
  アプリのキャッシュまで消すと、そのアプリのオフライン動作を
  壊してしまう

## 混同しやすい別物

- `web/lib/index.ts` の `LIBRARY_VERSION` は **JS ライブラリ自体の**
  バージョンで、アプリのリリースバージョン（タグ）とは別物。
  ライブラリの互換性が変わるときに上げるもので、`appVersion` と
  揃える必要はない
- QV フォーマットのバージョン（`docs/format.md`）も別物
