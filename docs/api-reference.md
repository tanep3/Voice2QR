# Voice2QR JS ライブラリ API リファレンス（利用者向け）

Voice2QR の機能を、自分の Web ページやツールから使うための
JavaScript ライブラリの説明です。

**声を QR コードに入れる／QR コードから声を取り出す**、その処理は
すべてこのライブラリが引き受けます。処理は読み込んだページの
ブラウザの中だけで完結し、サーバーとの通信は一切しません。

> この文書は利用者向けの案内です。設計仕様としての API 定義は
> [docs/js-api.md](js-api.md)、データ形式「QV」の仕様は
> [docs/format.md](format.md) にあります。

---

## 1. まず動かしてみる

最小の往復例です。声（PCM データ）を QR に入れ、画像から読み戻して、
再び声にするところまでを通します。

```html
<script type="module">
import { createVoice2Qr } from 'https://tanep3.github.io/Voice2QR/lib/v1/index.js';
import { drawQr, readPayloadFromImageData } from 'https://tanep3.github.io/Voice2QR/lib/v1/browser.js';

// 初期化（wasm を読み込みます。最初に1回だけ）
const v2q = await createVoice2Qr();

// ―― 入れる ――
// pcm は「8 kHz モノラル、16 bit」の音声データ（Int16Array）です。
const payload = await v2q.encode(pcm);            // 声 → バイト列（QV ペイロード）
const qr = await v2q.payloadToQr(payload);        // バイト列 → QR の図形データ
drawQr(document.querySelector('#qr'), qr);        // canvas に描く（ブラウザ用ヘルパ）

// ―― 取り出す ――
// 画像（ImageData）から QR を読む。カメラの映像フレームでも同じです。
const back = await v2q.qrToPayload(imageData);    // QR → バイト列
const info = await v2q.inspect(back);             // 中身を調べる（声の長さなど）
console.log(info.voice.durationMs);               // 例： 8640（= 8.64 秒の声）
const pcmOut = await v2q.decode(back);            // バイト列 → 声（Int16Array）
</script>
```

録音しながら少しずつ符号化したい場合は `createEncoder()` を使います
（§3）。再生は `decode` が返した PCM を Web Audio 等で鳴らすだけです
（§5 に例があります）。

### 読み込み方

- ライブラリは ES モジュールです。`<script type="module">` の中で
  `import` してください。
- 依存ファイル（wasm 3点）はライブラリと同じ場所に置かれていて、
  既定では自動で解決されます。自前でホストする場合も、`index.js` と
  同じフォルダに一式を並べればそのまま動きます。
- Node でも動きます（画像まわりはブラウザ用ヘルパではなく
  `qrToPayload` にピクセルデータを渡してください）。

### 約束ごと： PCM の形式

ライブラリが受け取る／返す音声は、必ず
**サンプリングレート 8 kHz・モノラル・16 bit（`Int16Array`）** です。
マイクの録音レート（48 kHz など）からの変換はライブラリの仕事では
ありません。録音側で 8 kHz 化してから渡してください
（Voice2QR の Web アプリもそうしています）。

## 2. できること一覧

| やりたいこと | 使う関数 |
|---|---|
| ライブラリを初期化する | `createVoice2Qr()` |
| 声を一度に符号化する | `v2q.encode(pcm)` |
| 録音しながら符号化する | `v2q.createEncoder()` |
| ペイロードを QR の図形にする | `v2q.payloadToQr(payload)` |
| 画像からペイロードを読む | `v2q.qrToPayload(image)` |
| ペイロードから声を復号する | `v2q.decode(payload)` |
| ペイロードの中身を調べる | `v2q.inspect(payload)` |
| 録れる上限の長さを知る | `v2q.maxDurationMs()` |
| QR を canvas に描く（ブラウザ） | `drawQr(canvas, qr)` |
| QR を PNG 画像にする（ブラウザ） | `payloadToPng(payload)` |
| ImageData から読む（ブラウザ） | `readPayloadFromImageData(imageData)` |

すべての関数は Promise を返します（`createEncoder` の返す
オブジェクトのプロパティ参照を除く）。

## 3. 関数の説明

### createVoice2Qr(options?)

ライブラリを初期化し、操作用のインスタンスを返します。
コアと Codec2 の wasm を読み込むため、最初に1回だけ呼んでください。

- `options.coreUrl` / `options.codec2Url`： wasm の URL を変えたい
  ときだけ指定します（通常は不要）。
- インスタンスの `v2q.version` に `{ library, format }` が入って
  います（`format` は対応する QV 形式の版、現在 2）。
- 失敗したときは `Voice2QrError`（code: `LOAD`）が投げられます。

### v2q.encode(pcm, options?)

PCM 全体を一度に符号化し、QV ペイロード（`Uint8Array`）を返します。
音声ファイルを取り込むなど、データが手元に揃っている場合に。

- `options.bps`： Codec2 のビットレート。既定 **1200**。
  対応値は 3200 / 2400 / 1600 / 1400 / 1300 / 1200 / 700。
  上げるほど音は良くなりますが、入る長さは短くなります。
- `options.ecLevel`： QR の誤り訂正レベル `'L' | 'M' | 'Q' | 'H'`。
  既定 **'M'**。容量の上限を決めるもので、実際に描く QR の訂正
  レベルは `payloadToQr` 側でも指定します（通常は揃えます）。
- 容量を超えると `TOO_LARGE`、未対応の bps は `UNSUPPORTED_BPS`。

### v2q.createEncoder(options?)

録音のように PCM が少しずつ届く場合の符号化です。
引数は `encode` と同じです。

```js
const encoder = v2q.createEncoder();
await encoder.push(chunk);          // Int16Array を渡す（何回でも）
console.log(encoder.payloadBytes);  // いま finish したときのペイロード長
const payload = await encoder.finish();
```

- `encoder.push(pcm)`： PCM を追加します。フレームに満たない端数は
  内部に保持され、次の `push` とつながります。容量を超えると
  `TOO_LARGE` が投げられます（それまでに入れた分は `finish()` で
  取り出せます）。
- `encoder.framesEncoded`： 符号化済みのフレーム数。
- `encoder.payloadBytes`： この時点で `finish()` した場合の
  ペイロード長（正確な値）。上限（訂正 M で 2,331 バイト）と
  比べれば、録音の自動停止や残り時間表示に使えます。
- `encoder.finish()`： 端数をゼロ詰めして締め、ペイロードを返します。

### v2q.payloadToQr(payload, options?)

ペイロードを QR のモジュール行列に変換します。描画そのものは
しません（ブラウザなら §4 の `drawQr` が使えます）。

- `options.ecLevel`： 既定 'M'。
- 戻り値 `QrMatrix`： `{ version, size, modules, ecLevel }`。
  `modules` は一辺 `size` の 0/1 の列（行優先、クワイエットゾーン
  を含みません）。
- ペイロードが QR の最大容量を超えると `QR_TOO_LARGE`。

### v2q.qrToPayload(image)

画像のピクセルデータから QR を探し、その中身のバイト列を
返します。`image` は `{ data, width, height }`（`ImageData` と
同じ形）です。

- QR が見つからないときは `QR_NOT_FOUND`。カメラ読み取りでは、
  フレームごとに呼び直し、このエラーが出る間は走査を続けるのが
  基本形です。
- 返ってきたバイト列が QV かどうかの判定はここではしません。
  `inspect` / `decode` が担います。
- 第2引数に `{ scaleRetry: true }` を渡すと、通常の読み取りが
  失敗したときだけ、粘るリトライが働きます。まずファインダ
  パターンの走査でコードの位置を推定して切り出し（候補が
  見つからなければそのまま次へ）、切り出した画像と元の画像の
  それぞれに、大きな幅へ拡大して提示し直すリトライを試します
  （スケールラダー）。読み取り器はカメラで大きく捉えたコードに
  最適化されているため、フレームの一部に小さく写ったコードや
  低解像度の画像に写った高密度のコードは、元の大きさでは
  読めなくても、切り出しや拡大提示で読めることがあります。提示幅は 1800 / 2600 / 3400 / 4200 px、提示画像の
  面積は 16,000,000 px が上限で、元の幅の1.2倍を超えない段は
  試しません（すでに十分大きい画像では拡大リトライは0回です）。
  拡大は Lanczos-3 補間です。成功した読み取りは通常の読み取りと
  同じく読み取り器自身のチェックサムで検証されたものです。

### v2q.decode(payload)

ペイロードから声を取り出し、PCM（`Int16Array`、8 kHz モノラル）
を返します。将来の拡張で TEXT / IMAGE が混ざったペイロードでも、
声の部分だけを取り出して再生できます。

- エラー： `NOT_QV` / `UNSUPPORTED_VERSION` / `MALFORMED` /
  `NO_VOICE`（声が入っていない）/ `UNSUPPORTED_BPS`。

### v2q.inspect(payload)

ペイロードを変えずに中身の要約だけを返します。

```js
{
  version: 2,
  voice: { bps: 1200, frames: 216, durationMs: 8640 },  // 声が無ければ undefined
  hasText: false,
  hasImage: false
}
```

### v2q.maxDurationMs(options?)

その bps と誤り訂正レベルで録音できる上限時間をミリ秒で返します。
引数は `encode` と同じ。録音画面のカウントダウン表示などに。

誤り訂正 M の場合の上限の目安：

| bps | 上限の目安 |
|---|---|
| 3200 | 約 5.8 秒 |
| 2400 | 約 7.7 秒 |
| 1600 | 約 11.6 秒 |
| 1400 / 1300 | 約 13 秒 |
| 1200（既定） | 約 15.4 秒 |
| 700 | 約 23 秒 |

## 4. ブラウザ用ヘルパ

DOM に触る便利関数は、本体とは別のファイル `browser.js` から
読み込みます（Node 利用者を DOM 前提に巻き込まないためです）。

```js
import { drawQr, payloadToPng, readPayloadFromImageData }
  from 'https://tanep3.github.io/Voice2QR/lib/v1/browser.js';
```

- `drawQr(canvas, matrix, options?)`： `payloadToQr` の戻り値を
  canvas に描きます。整数倍拡大＋クワイエットゾーン付きで、
  印刷しても滲みません。`options.modulePx` で1マスの画素数、
  `options.quietZone` で余白のマス数（既定 4）を変えられます。
- `payloadToPng(payload, options?)`： ペイロードから PNG の
  `Blob` を作ります。保存や共有シートへの受け渡しに。
- `readPayloadFromImageData(imageData)`： `ImageData` をそのまま
  `qrToPayload` に渡すラッパです。

## 5. 再生の例（Web Audio）

`decode` の返す PCM は 8 kHz です。端末のレートへ変換して
鳴らします：

```js
const pcm = await v2q.decode(payload);
const ctx = new AudioContext();
const buffer = ctx.createBuffer(1, pcm.length, 8000);
buffer.getChannelData(0).set(Float32Array.from(pcm, (s) => s / 32768));
const src = ctx.createBufferSource();
src.buffer = buffer;
src.connect(ctx.destination);
src.start();
```

## 6. エラー

失敗はすべて `Voice2QrError` で投げられ、`code` で種類が分かります。
画面に出す文言はライブラリでは決めません。利用側が `code` を見て
決めてください（Voice2QR のアプリでは、読み取れなかった系を
まとめて「読み取れませんでした」と表示しています）。

```js
import { Voice2QrError } from 'https://tanep3.github.io/Voice2QR/lib/v1/index.js';

try {
  const pcm = await v2q.decode(payload);
} catch (e) {
  if (e instanceof Voice2QrError && e.code === 'NO_VOICE') {
    // 声が入っていない QR だった
  }
}
```

| code | 意味 | よくある場面 |
|---|---|---|
| `LOAD` | wasm の読み込みに失敗 | 配置ミス、ファイル不足 |
| `NOT_QV` | QV データではない | Voice2QR でない QR を読んだ |
| `UNSUPPORTED_VERSION` | 形式の版が未対応 | 新しい形式の QR を古いライブラリで読んだ |
| `MALFORMED` | 構造が壊れている | 破損したデータ |
| `NO_VOICE` | 声が入っていない | テキストのみ等のペイロード |
| `UNSUPPORTED_BPS` | その bps に未対応 | — |
| `TOO_LARGE` | 容量を超えた | 長い録音、大きなファイル |
| `QR_NOT_FOUND` | 画像から QR が見つからない | カメラ走査中は正常系として扱う |
| `QR_TOO_LARGE` | QR の最大容量を超える | 大きすぎるペイロード |
| `INVALID_ARGUMENT` | 引数が不正 | — |

## 7. 版と互換性

- ライブラリは SemVer で版管理します。公開 URL の版ディレクトリ
  （`/lib/v1/`）の中では後方互換を保ち、破壊的な変更は新しい
  ディレクトリで出します。旧版は消しません。利用側は URL で版を
  固定できます。
- QV 形式の仕様は [docs/format.md](format.md) です。復号側は
  すべての bps に対応します（符号化時の指定によらず、読み取りは
  全部受け付けます）。
