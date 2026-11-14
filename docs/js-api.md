# Voice2QR JS ライブラリ API リファレンス

GitHub Pages で公開する JS ライブラリの公開 API。Web アプリ・CLI・
他人の Web アプリは、すべてこの API を使って Voice2QR の機能
（声を QR に入れる／QR から声を取り出す）を実現する。

ステータス： 凍結（2026-11-14、レビュー済み）。変更は版を上げて行う。

---

## 1. まず全体像： これで何ができるか

ライブラリの仕事は次の4つ。

1. **符号化**： 録音した声（PCM）を QV ペイロード（バイト列）に変える
2. **QR 化**： ペイロードを QR のモジュール行列に変える／画像から戻す
3. **復号**： ペイロードから声（PCM）を取り出す
4. **観測**： ペイロードの中身（声の長さ等）を調べる

使い方はこの流れになる（ブラウザでも Node でも同じ）：

```ts
import { createVoice2Qr } from 'https://tanep3.github.io/Voice2QR/lib/v1/index.js';

// 初期化（wasm を読み込む）。最初に1回だけ。
const v2q = await createVoice2Qr();

// ―― 声を QR に入れる ――
// pcm は「8 kHz モノラル」の録音データ（Int16Array）。
const encoder = v2q.createEncoder();        // 既定： 1200 bps / 誤り訂正 M
await encoder.push(pcm);                    // 録音しながら少しずつ渡してもよい
const payload = await encoder.finish();     // → Uint8Array（QV ペイロード）

// ペイロードを QR のモジュール行列にする（描画は利用側）。
const qr = await v2q.payloadToQr(payload);  // → { version, size, modules, ecLevel }

// ―― QR から声を取り出す ――
// 画像のピクセル（RGBA）からペイロードを読む。
const back = await v2q.qrToPayload({ data, width, height });  // → Uint8Array

const info = await v2q.inspect(back);       // → 中身の要約（声の長さなど）
const pcmOut = await v2q.decode(back);      // → Int16Array（再生用 PCM）
```

用語：

- **PCM**： デジタル音声の生データ。本ライブラリでは
  「8 kHz モノラル、16 bit サンプル列（`Int16Array`）」と約束する。
  端末の録音レート（48 kHz 等）からの変換はライブラリの仕事ではなく、
  録音側が済ませてから渡す。
- **ペイロード**： QV フォーマット v2 のバイト列（`Uint8Array`）。
  QR の中に入るデータそのもの。仕様は `docs/format.md`。
- **モジュール**： QR の白黒のマス目1つ。

## 2. 関数一覧

| 関数 | 何をするか | 戻り値 |
|---|---|---|
| `createVoice2Qr(options?)` | ライブラリを初期化する | `Promise<Voice2Qr>` |
| `v2q.inspect(payload)` | ペイロードの中身を調べる（観測） | `Promise<Info>` |
| `v2q.encode(pcm, options?)` | PCM を一度に符号化する | `Promise<Uint8Array>`（ペイロード） |
| `v2q.createEncoder(options?)` | 録音用の分割符号化を開始する | `Encoder` |
| `encoder.push(pcm)` | PCM を追加する | `Promise<void>` |
| `encoder.finish()` | 符号化を終えてペイロードを返す | `Promise<Uint8Array>` |
| `v2q.decode(payload)` | ペイロードから PCM を取り出す | `Promise<Int16Array>` |
| `v2q.maxDurationMs(options?)` | 録れる上限時間（ms）を返す | `Promise<number>` |
| `v2q.payloadToQr(payload, options?)` | ペイロードを QR 行列にする | `Promise<QrMatrix>` |
| `v2q.qrToPayload(image)` | 画像のピクセルからペイロードを読む | `Promise<Uint8Array>` |

`v2q` は `createVoice2Qr()` が返したインスタンスを指す。

## 3. 関数の詳細

### createVoice2Qr(options?)

ライブラリを初期化する。コアと Codec2 の wasm を読み込むため
非同期（Promise）である。アプリの起動時に1回呼ぶ。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `options.coreUrl` | string | 任意 | コア wasm の URL。既定はライブラリ自身の場所からの相対解決 |
| `options.codec2Url` | string | 任意 | Codec2 wasm の URL。既定は同上 |

戻り値： `Promise<Voice2Qr>`。失敗時は `Voice2QrError`（code: `LOAD`）。

インスタンスのプロパティ：

| 名前 | 型 | 説明 |
|---|---|---|
| `v2q.version` | `{ library: string, format: number }` | ライブラリの版と、対応する QV フォーマットの版（現在 2） |

### v2q.encode(pcm, options?)

PCM 全体を一度に符号化してペイロードを返す。音声ファイルの取込など、
データが手元に揃っている場合に使う。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `pcm` | Int16Array | 必須 | 8 kHz モノラルの音声 |
| `options.bps` | number | 任意 | Codec2 のビットレート。既定 1200 |
| `options.ecLevel` | 'L' \| 'M' \| 'Q' \| 'H' | 任意 | QR の誤り訂正レベル。容量の上限を決める。既定 'M' |

戻り値： `Promise<Uint8Array>`（ペイロード）。
エラー： 容量を超えたら `TOO_LARGE`、未対応の bps は `UNSUPPORTED_BPS`。

### v2q.createEncoder(options?) ／ Encoder

録音のように PCM が少しずつ届く場合の分割符号化。
引数は `encode` の `options` と同じ。

```ts
const encoder = v2q.createEncoder();
await encoder.push(chunk1);   // Int16Array を追加（フレーム境界まで内部で保持）
await encoder.push(chunk2);
console.log(encoder.framesEncoded);  // 符号化済みフレーム数
console.log(encoder.payloadBytes);   // 完成ペイロードのバイト数（正確値）
const payload = await encoder.finish();
```

| 名前 | 型 | 説明 |
|---|---|---|
| `encoder.push(pcm)` | Promise<void> | PCM を追加する。容量を超えたら `TOO_LARGE` |
| `encoder.framesEncoded` | number | ここまでで符号化できたフレーム数 |
| `encoder.payloadBytes` | number | この時点で finish した場合のペイロード長。上限（訂正 M で 2,331）との比較で録音の自動停止に使う |
| `encoder.finish()` | Promise<Uint8Array> | 端数サンプルをゼロ詰めして最終フレームにし、ペイロードを返す |

### v2q.decode(payload)

ペイロードから VOICE セクションを取り出し、PCM に復号して返す。
TEXT / IMAGE セクションが混ざっていても読み飛ばす（将来の
マルチメディア QR の音声だけを再生できる）。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `payload` | Uint8Array | 必須 | QV ペイロード |

戻り値： `Promise<Int16Array>`（8 kHz モノラルの PCM）。
再生時のレート変換（8 kHz → 端末のレート）は利用側の仕事。
エラー： `NOT_QV` / `UNSUPPORTED_VERSION` / `MALFORMED` /
`NO_VOICE` / `UNSUPPORTED_BPS`。

### v2q.inspect(payload)

ペイロードを変更せず、中身の要約だけを返す（観測）。

戻り値： `Promise<Info>`

```ts
{
  version: 2,                                        // QV フォーマットの版
  voice: { bps: 1200, frames: 216, durationMs: 8640 }, // 無ければ undefined
  hasText: false,
  hasImage: false
}
```

### v2q.maxDurationMs(options?)

その bps と誤り訂正レベルで録音できる上限時間をミリ秒で返す。
録音画面のカウントダウンの初期値に使う。
引数は `encode` の `options` と同じ。

### v2q.payloadToQr(payload, options?)

ペイロードを QR のモジュール行列に変換する。描画そのものはしない
（canvas への描画や PNG 化は利用側。ブラウザ用ヘルパは §4）。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `payload` | Uint8Array | 必須 | QV ペイロード |
| `options.ecLevel` | 'L' \| 'M' \| 'Q' \| 'H' | 任意 | 既定 'M' |

戻り値： `Promise<QrMatrix>`

```ts
{
  version: 30,        // QR のバージョン（1–40）
  size: 137,          // 一辺のモジュール数（クワイエットゾーンを含まない）
  modules: Uint8Array, // 行優先の 0/1、長さ size × size
  ecLevel: 'M'
}
```

エラー： QR の最大容量を超えたら `QR_TOO_LARGE`。

### v2q.qrToPayload(image)

画像のピクセルから QR を探し、生バイト列（ペイロード）を返す。
QV かどうかの判定はここではしない（`inspect` / `decode` の仕事）。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `image.data` | Uint8Array \| Uint8ClampedArray | 必須 | RGBA ピクセル列（ImageData と同形） |
| `image.width` | number | 必須 | 横ピクセル数 |
| `image.height` | number | 必須 | 縦ピクセル数 |

戻り値： `Promise<Uint8Array>`。
エラー： QR が見つからなければ `QR_NOT_FOUND`。カメラ読取では、
利用側がフレームを繰り返し渡し、`QR_NOT_FOUND` の間は走査を続ける。

## 4. ブラウザ用ヘルパ（別エントリ）

DOM に触る便利関数は、本体とは別のエントリ `voice2qr/browser`
から提供する（Node 利用者を DOM 前提に巻き込まないため）。

```ts
import { drawQr, payloadToPng, readPayloadFromImageData }
  from 'https://tanep3.github.io/Voice2QR/lib/v1/browser.js';
```

| 関数 | 何をするか |
|---|---|
| `drawQr(canvas, matrix, options?)` | `QrMatrix` を canvas に描く（整数倍拡大、クワイエットゾーン付き）。`options.modulePx` で1モジュールの画素数、`options.quietZone` で余白のモジュール数（既定4） |
| `payloadToPng(payload, options?)` | ペイロードから PNG の `Blob` を作る（保存・共有用） |
| `readPayloadFromImageData(imageData)` | `ImageData` からペイロードを読む（`qrToPayload` のラッパ） |

## 5. エラー

失敗はすべて `Voice2QrError` という例外で投げられ、`code` プロパティで
種類が分かる。表示文言はライブラリでは決めず、利用側が code から
決める（例： アプリでは `NOT_QV` / `NO_VOICE` / `MALFORMED` を
まとめて「読み取れませんでした」と表示する）。

```ts
try {
  const pcm = await v2q.decode(payload);
} catch (e) {
  if (e instanceof Voice2QrError && e.code === 'NO_VOICE') { /* ... */ }
}
```

| code | 意味 |
|---|---|
| `LOAD` | wasm の読み込み・初期化に失敗した |
| `NOT_QV` | QV データではない |
| `UNSUPPORTED_VERSION` | 形式の版が未対応 |
| `MALFORMED` | 構造が壊れている |
| `NO_VOICE` | VOICE セクションが無い |
| `UNSUPPORTED_BPS` | その bps に未対応 |
| `TOO_LARGE` | 容量を超えた（符号化） |
| `QR_NOT_FOUND` | 画像から QR が見つからない |
| `QR_TOO_LARGE` | ペイロードが QR の最大容量を超える |
| `INVALID_ARGUMENT` | 引数が不正 |

コア側のエラー（コア API 設計 `docs/core-api.md` §3.2）と 1 対 1 に
対応させ、QR 層と読み込み層の分を足してある。

## 6. 設計メモ

- **環境非依存**： 本体はブラウザでも Node でも動く。DOM に触る物は
  §4 の別エントリに隔離した。環境で変わる処理（画像のピクセル化、
  ファイル入出力）は利用側のアダプタが担う。
- **非同期で統一**： 内部の wasm 呼び出しは同期だが、公開面は
  Promise で揃える（将来のワーカー化を妨げないため）。
- **容量の対応表**： 誤り訂正レベル → QR のバイト容量
  （L = 2,953 / M = 2,331 / Q = 1,663 / H = 1,273）はライブラリが
  持ち、コアへは上限バイト数として渡す。
- **版と互換性**： ライブラリは SemVer。公開 URL の版（`/lib/v1/`）の
  配下では後方互換を保ち、破壊的変更は新しい版ディレクトリで出す。
  旧版は消さない（利用者が版を固定して読み込むため）。
- **テスト**： ライブラリのテストは Node で回し、ゴールデンテストの
  フィクスチャ（`fixtures/`）で「原音声 → ペイロード」と
  「ペイロード → PCM」の一致を確認する。ブラウザ用ヘルパは
  アプリの動作確認で担保する。
