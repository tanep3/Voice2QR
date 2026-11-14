# Voice2QR JS ライブラリ API 設計

GitHub Pages で公開する JS ライブラリ（システム設計 `docs/system-design.md`
§4.1）の公開 API 設計。Web アプリ・CLI・他人の Web アプリは、
すべてこの API に対して実装する。

ステータス： 設計ドラフト（2026-11-14）。レビューを経て凍結する。

## 1. 設計原則

- **環境非依存**： ブラウザでも Node でも動く。DOM に触らない。
  環境で変わる処理（画像のピクセル化、ファイル入出力）は呼び出し側の
  アダプタが担い、ライブラリは標準的なデータ型だけを受け取る。
- **非同期で統一**： 初期化も各操作も Promise を返す。内部の wasm
  呼び出しは同期だが、公開面は非同期で揃える（将来のワーカー化を
  妨げないため）。
- **ライブラリは言葉を持たない**： エラーはコードで返し、表示文言は
  利用側（アプリ）が i18n で決める。ライブラリ内に利用者向け文言を
  持たない。
- **サンプリング変換はしない**： PCM は「8 kHz モノラル i16」が契約。
  端末レートからの変換は録音側（アダプタ）の仕事であり、ライブラリは
  変換済みの PCM だけを扱う。

## 2. データ型

| 型 | 中身 |
|---|---|
| PCM | `Int16Array`。8 kHz モノラル、16 bit リトルエンディアン相当のサンプル列 |
| ペイロード | `Uint8Array`。QV フォーマット v2 のバイト列（`docs/format.md`） |
| `PixelData` | `{ data: Uint8Array \| Uint8ClampedArray, width: number, height: number }`。RGBA 8 bit/成分のピクセル列（ImageData と同形） |
| `QrMatrix` | QR のモジュール行列（§5） |

## 3. 初期化

```ts
export interface Voice2QrOptions {
  /** コア wasm の URL。既定はライブラリ自身の場所からの相対解決。 */
  coreUrl?: string;
  /** Codec2 wasm の URL。既定は同上。 */
  codec2Url?: string;
}

/** wasm を読み込んで初期化し、インスタンスを返す。 */
export function createVoice2Qr(options?: Voice2QrOptions): Promise<Voice2Qr>;

export interface Voice2Qr {
  /** ライブラリ版と QV フォーマット版。 */
  readonly version: { library: string; format: number };
  inspect(payload: Uint8Array): Promise<Info>;
  encode(pcm: Int16Array, options?: EncodeOptions): Promise<Uint8Array>;
  createEncoder(options?: EncodeOptions): Encoder;
  decode(payload: Uint8Array): Promise<Int16Array>;
  maxDurationMs(options?: EncodeOptions): Promise<number>;
  payloadToQr(payload: Uint8Array, options?: QrOptions): Promise<QrMatrix>;
  qrToPayload(image: PixelData): Promise<Uint8Array>;
}
```

- wasm の置き場所は、既定ではライブラリモジュール自身の URL
  （`import.meta.url`）から相対で解決する。同居配置（アプリ、
  GitHub Pages）がそのまま成立し、自前ホストでもファイルを並べれば
  動く。`coreUrl` / `codec2Url` は配置を分けたい場合の上書き用。
- インスタンスは複数作れる（状態は符号化セッション単位で持ち、
  インスタンス自体は軽い）。

## 4. 符号化・復号・観測

```ts
export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface EncodeOptions {
  /** Codec2 の bps。既定 1200。 */
  bps?: number;
  /** QR 誤り訂正レベル。容量の上限を決める。既定 'M'。 */
  ecLevel?: EcLevel;
}

export interface Info {
  version: number;
  voice?: { bps: number; frames: number; durationMs: number };
  hasText: boolean;
  hasImage: boolean;
}
```

- `encode`： ワンショット符号化（ファイル取込用）。容量を超えたら
  `TOO_LARGE` エラー。
- `createEncoder`： 録音用のストリーミング符号化。

```ts
export interface Encoder {
  /** PCM を追加し、フレーム境界まで内部でバッファする。 */
  push(pcm: Int16Array): Promise<void>;
  /** 符号化済みフレーム数。 */
  readonly framesEncoded: number;
  /** 完成ペイロードのバイト数（正確値）。上限との比較に使う。 */
  readonly payloadBytes: number;
  /** 終了してペイロードを返す。端数はゼロ詰めで最終フレーム化。 */
  finish(): Promise<Uint8Array>;
}
```

録音の自動停止は、`payloadBytes` が容量（ecLevel から決まる）に
達する手前でアプリ側が `finish` を呼ぶことで行う。`push` 自体も、
容量を超える場合は `TOO_LARGE` を投げて止める（保険）。

- `decode`： ペイロードから VOICE を取り出して PCM を返す。
  TEXT / IMAGE セクションは読み飛ばす（マルチメディア互換）。
  再生時のサンプリングレート変換（8 kHz → 端末レート）は呼び出し側
  （Web Audio 等）の仕事とする。
- `inspect`： 観測専用。データを変更しない。
- `maxDurationMs`： その bps と ecLevel で録れる上限時間。
  カウントダウン表示の初期値に使う。

容量（バイトモード、最大バージョン40）： L = 2,953 / M = 2,331 /
Q = 1,663 / H = 1,273。ecLevel から容量を引く対応表はライブラリが
持ち、コアへは `capacity` として渡す（コア API 設計 §3.4）。

## 5. QR の生成と読取

```ts
export interface QrOptions {
  ecLevel?: EcLevel; // 既定 'M'
}

export interface QrMatrix {
  /** QR のバージョン（1–40）。 */
  version: number;
  /** 一辺のモジュール数（= 17 + 4 × version）。クワイエットゾーンを含まない。 */
  size: number;
  /** 行優先の 0/1。長さ size × size。 */
  modules: Uint8Array;
  ecLevel: EcLevel;
}
```

- `payloadToQr`： ペイロード → モジュール行列。描画（canvas、PNG 化）は
  環境側の仕事であり、ライブラリは行列までを返す。これにより
  「整数倍拡大・補間なし」の描画規則は描く側が守る（ブラウザ用
  ヘルパは §6）。
- `qrToPayload`： `PixelData` から QR を探して生バイト列を返す。
  見つからなければ `QR_NOT_FOUND`。QV かどうかの判定はここでは
  しない（`inspect` / `decode` の仕事）。カメラ読取では、アプリ側が
  フレームを繰り返し渡し、`QR_NOT_FOUND` の間は走査を続ける。

## 6. ブラウザ用ヘルパ（別エントリ）

DOM に触る便利関数は本体と分け、サブパスエントリ
`voice2qr/browser` で提供する（Node 利用者を DOM 前提に巻き込まない）。

```ts
/** QrMatrix を canvas に描く。整数倍拡大、クワイエットゾーン付き。 */
export function drawQr(canvas: HTMLCanvasElement, matrix: QrMatrix,
                       options?: { modulePx?: number; quietZone?: number }): void;

/** ペイロードから PNG の Blob を作る（保存・共有用）。 */
export function payloadToPng(payload: Uint8Array,
                             options?: QrOptions & { modulePx?: number }): Promise<Blob>;

/** ImageData からペイロードを読む（qrToPayload のラッパ）。 */
export function readPayloadFromImageData(image: ImageData): Promise<Uint8Array>;
```

## 7. エラー

すべての失敗は `Voice2QrError`（`code` プロパティ付き）で投げる。

| code | 意味 | 主な発生源 |
|---|---|---|
| `LOAD` | wasm の読み込み・初期化に失敗 | createVoice2Qr |
| `NOT_QV` | QV データではない | inspect / decode |
| `UNSUPPORTED_VERSION` | 形式の版が未対応 | inspect / decode |
| `MALFORMED` | 構造の破損 | inspect / decode |
| `NO_VOICE` | VOICE セクションが無い | decode |
| `UNSUPPORTED_BPS` | その bps に未対応 | encode / decode |
| `TOO_LARGE` | 容量超過 | encode / Encoder |
| `QR_NOT_FOUND` | 画像から QR が見つからない | qrToPayload |
| `QR_TOO_LARGE` | ペイロードが QR の最大容量を超える | payloadToQr |
| `INVALID_ARGUMENT` | 引数の不正 | 全般 |

コアのエラー（コア API 設計 §3.2）と 1 対 1 に対応させ、QR 層と
読み込み層の分を足した。利用者向け表示への対応はアプリ側の責務
（例： NOT_QV / NO_VOICE / MALFORMED →「読み取れませんでした」）。

## 8. 版と互換性

- ライブラリは SemVer。公開 URL の版（`/lib/v1/` 等）はメジャー版を
  示し、その配下では後方互換を保つ（マイナー／パッチのみ）。
- 破壊的変更は新しい版ディレクトリで出す。旧版は残す
  （アプリが版を固定して読み込むため、消すと既存の利用者が壊れる）。
- 形式（QV）の版とは独立に管理する。`version.format` で実行時に
  形式の版を確認できる。

## 9. テスト

- ライブラリのテストは Node で回す（環境非依存であることの担保を
  兼ねる）。ゴールデンテストのフィクスチャ（`fixtures/`）を使い、
  「原音声 PCM → ペイロード」が正解バイト列と一致すること、
  「ペイロード → PCM」がスパイクの復号結果と一致することを確認する。
- ブラウザ用ヘルパはアプリ側の動作確認で担保する（単体テストの
  対象にしない）。
