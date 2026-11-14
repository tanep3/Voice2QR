# Voice2QR コア API 設計

共通コア（Rust、C ABI 公開）の API 設計。正本は要件文書
`docs/requirements.md` とフォーマット仕様 `docs/format.md` であり、
本書はその下で「コアが何を提供し、何を提供しないか」を定める。

ステータス： 凍結（2026-11-14、レビュー済み）。変更は版を上げて行う。

## 1. コアの境界

コアが担うのは次の2つだけである。

- QV フォーマット（v2）の入出力： バイト列 ⇔ 構造化データの変換
- Codec2 への接続： PCM ⇔ Codec2 フレーム列の変換

コアの外にあるもの（各アプリ＝顔の側の責務）：

- QR コードの生成（バイト列 → モジュール行列）と読取（画像 → バイト列）
- マイク録音、音声ファイルのデコード、スピーカ再生
- 印刷レイアウト、UI、言語切替

つまりコアが扱うデータの出入り口は「PCM サンプル列」と「QV ペイロード
バイト列」であり、QR 画像そのものはコアを通らない。

## 2. レイヤ構成

| レイヤ | 内容 | 依存 |
|---|---|---|
| `qv` | フォーマットの構造だけを扱う純粋な層。parse（バイト列→構造）と build（構造→バイト列）。コーデックの知識を持たない | なし |
| `codec` | コーデックの抽象（trait）と、libcodec2 への FFI 実装。モード情報（bps → フレーム長・サンプル数）は libcodec2 自身の問い合わせ関数から得る | libcodec2（動的リンク／別モジュール） |
| `engine` | `qv` と `codec` を束ねる実行層。inspect、符号化セッション、復号を提供する | `qv`, `codec` |
| `ffi` | C ABI。`engine`（libcodec2 実装）を C の関数群として公開する。WASM と Android JNI はここを叩く | `engine` |

観測と作用を分ける：

- **観測**： `inspect` はペイロードを変更せず「何が入っているか」
  （バージョン、音声の有無と長さ、TEXT / IMAGE の有無）だけを返す。
- **作用**： 符号化と復号だけがデータを変換する。

## 3. Rust API（契約）

### 3.1 型（`qv` 層）

```rust
pub const QV_VERSION: u8 = 2;
/// 訂正 M のバイトモード容量。QR 層の定数だが、容量計算の基準として公開する。
pub const QR_CAPACITY_M: usize = 2331;

#[derive(Clone, PartialEq, Debug)]
pub enum Section {
    Voice(VoiceSection),
    Text(String),
    Image(ImageSection),
    /// 未知の種別。読み飛ばさず保持し、build でそのまま書き戻せる。
    Unknown { kind: u8, data: Vec<u8> },
}

#[derive(Clone, PartialEq, Debug)]
pub struct VoiceSection {
    pub bps: u16,
    pub frame_count: u16,
    /// Codec2 フレーム列。長さの正しさ（frame_count × フレーム長）の
    /// 検証は codec 層の責務であり、qv 層は構造だけを見る。
    pub frames: Vec<u8>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ImageSection {
    pub codec: ImageCodec, // WebP | Jpeg
    pub data: Vec<u8>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Payload {
    pub version: u8,
    pub sections: Vec<Section>,
}

impl Payload {
    /// バイト列 → 構造。magic 不一致・version 不一致・セクション長の
    /// 溢れはエラー。未知セクションは Unknown として保持される。
    pub fn parse(bytes: &[u8]) -> Result<Payload, Error>;
    /// 構造 → バイト列。決定的な出力のため、セクションは保持した
    /// 順序のまま書き出す（書き手は type 昇順に積むこと）。
    pub fn build(&self) -> Vec<u8>;
    /// 最初の VOICE セクションを返す（仕様： 複数ある場合は先頭採用）。
    pub fn voice(&self) -> Option<&VoiceSection>;
}
```

### 3.2 エラー

```rust
#[derive(Debug)]
pub enum Error {
    /// 先頭が "QV" ではない
    NotQv,
    /// 対応していない version
    UnsupportedVersion(u8),
    /// セクション長の溢れ、VOICE の value が 4 バイト未満など構造の破損
    Malformed(&'static str),
    /// VOICE セクションが無い
    NoVoiceSection,
    /// その bps のモードをコーデックが知らない
    UnsupportedBps(u16),
    /// 容量を超えた（長さと上限を保持）
    PayloadTooLarge { len: usize, capacity: usize },
    /// コーデック側の失敗
    Codec(&'static str),
    /// 引数の不正（空入力、ヌル相当など）
    InvalidArgument(&'static str),
}
```

UI との対応： `NotQv` / `NoVoiceSection` / `Malformed` はいずれも
利用者には「読み取れませんでした」として表示する（要件 §4.1）。

### 3.3 コーデック抽象（`codec` 層）

```rust
pub struct ModeInfo {
    pub samples_per_frame: usize, // 1200 bps では 320（40 ms）
    pub bytes_per_frame: usize,   // 1200 bps では 6
}

pub trait Codec {
    /// bps に対応するモード情報。知らない bps なら None。
    fn mode_info(&self, bps: u16) -> Option<ModeInfo>;
    fn encoder(&self, bps: u16) -> Result<Box<dyn EncodeSession>, Error>;
    fn decoder(&self, bps: u16) -> Result<Box<dyn DecodeSession>, Error>;
}

/// 1フレーム分の符号化セッション（状態を持つ）。
pub trait EncodeSession {
    /// samples はちょうど ModeInfo.samples_per_frame 個。
    fn encode_frame(&mut self, samples: &[i16], out: &mut [u8]);
}

/// 1フレーム分の復号セッション（状態を持つ）。
pub trait DecodeSession {
    /// frame はちょうど ModeInfo.bytes_per_frame バイト。
    fn decode_frame(&mut self, frame: &[u8], out: &mut [i16]);
}
```

本番実装 `LibCodec2` は libcodec2 の C API を FFI で叩く。モード情報は
ハードコードの表ではなく `codec2_samples_per_frame` /
`codec2_bytes_per_frame` 相当の問い合わせでライブラリ自身から得る
（表と実物の二重管理をしない）。

### 3.4 実行層（`engine` 層）

```rust
/// 観測： ペイロードの中身の要約。データは変更しない。
pub struct Info {
    pub version: u8,
    pub voice: Option<VoiceInfo>,
    pub has_text: bool,
    pub has_image: bool,
}

pub struct VoiceInfo {
    pub bps: u16,
    pub frame_count: u16,
    pub duration_ms: u32, // frame_count × samples_per_frame / 8kHz
}

pub fn inspect<C: Codec>(codec: &C, payload: &[u8]) -> Result<Info, Error>;

/// 符号化セッション。録音はストリーミングで PCM が届くため、
/// push 式にする。ファイル取込用にはワンショット版も用意する。
pub struct Encoder<C: Codec> { /* ... */ }

impl<C: Codec> Encoder<C> {
    /// capacity は完成ペイロードの上限バイト数（訂正レベルと
    /// モードから顔側が決める。標準は QR_CAPACITY_M）。
    pub fn new(codec: C, bps: u16, capacity: usize) -> Result<Self, Error>;
    /// 任意の長さの PCM を受け、フレーム境界まで内部でバッファする。
    /// 完成ペイロードが capacity を超える見込みになったら
    /// PayloadTooLarge を返す（顔側は録音の自動停止に使える）。
    pub fn push_pcm(&mut self, samples: &[i16]) -> Result<(), Error>;
    /// ここまでで符号化済みのフレーム数と、完成ペイロード長（概算でなく正確値）。
    pub fn frames_encoded(&self) -> u32;
    pub fn payload_len(&self) -> usize;
    /// 終了して QV ペイロードを返す。端数のサンプル（1フレーム未満）は
    /// ゼロ詰めして1フレームにする。
    pub fn finish(self) -> Result<Vec<u8>, Error>;
}

/// ワンショット符号化（ファイル取込用）。
pub fn encode<C: Codec>(codec: C, pcm: &[i16], bps: u16, capacity: usize)
    -> Result<Vec<u8>, Error>;

/// 復号： ペイロードから VOICE を取り出して PCM を返す。
/// TEXT / IMAGE セクションは読み飛ばす（マルチメディア互換の要）。
pub fn decode<C: Codec>(codec: &C, payload: &[u8]) -> Result<Vec<i16>, Error>;

/// その bps と capacity で録音できる上限時間（カウントダウン表示用）。
pub fn max_duration_ms<C: Codec>(codec: &C, bps: u16, capacity: usize)
    -> Result<u32, Error>;
```

## 4. C ABI（`ffi` 層、`core/include/qv.h`）

Rust API の射影として、以下の C 関数群を公開する。WASM（Web 顔）と
JNI（Android 顔）はこの ABI だけを見る。

```c
typedef enum {
    QV_OK = 0,
    QV_ERR_NOT_QV = 1,
    QV_ERR_UNSUPPORTED_VERSION = 2,
    QV_ERR_MALFORMED = 3,
    QV_ERR_NO_VOICE = 4,
    QV_ERR_UNSUPPORTED_BPS = 5,
    QV_ERR_TOO_LARGE = 6,
    QV_ERR_CODEC = 7,
    QV_ERR_INVALID_ARGUMENT = 8
} QvStatus;

/// コアが確保したバイト列。受け取った側が qv_bytes_free で
/// ちょうど1回だけ解放する。decode の場合は中身は i16 サンプルの
/// リトルエンディアン列であり、サンプル数 = len / 2。
typedef struct { uint8_t *data; size_t len; } QvBytes;

typedef struct {
    uint8_t version;
    int has_voice;
    uint16_t bps;          // has_voice のときのみ有効
    uint32_t frame_count;  // 同上
    uint32_t duration_ms;  // 同上
    int has_text;
    int has_image;
} QvInfo;

QvStatus qv_inspect(const uint8_t *payload, size_t len, QvInfo *out);
QvStatus qv_decode(const uint8_t *payload, size_t len, QvBytes *out_pcm);
QvStatus qv_encode(const int16_t *pcm, size_t samples, uint16_t bps,
                   size_t capacity, QvBytes *out_payload);

typedef struct QvEncoder QvEncoder; // 不透明ハンドル
QvStatus qv_encoder_new(uint16_t bps, size_t capacity, QvEncoder **out);
QvStatus qv_encoder_push(QvEncoder *enc, const int16_t *pcm, size_t samples);
QvStatus qv_encoder_stats(const QvEncoder *enc, uint32_t *frames,
                          size_t *payload_len);
/// 成功・失敗いずれでもハンドルは解放される。
QvStatus qv_encoder_finalize(QvEncoder *enc, QvBytes *out_payload);
void qv_encoder_free(QvEncoder *enc);

void qv_bytes_free(QvBytes *b);
uint32_t qv_max_duration_ms(uint16_t bps, size_t capacity);
```

所有権の規則：

- 入力ポインタ（payload、pcm）は呼び出しの間だけ有効であればよい
  （コアは保持しない）。
- 出力 `QvBytes` の所有権は呼び出し側へ移る。解放は
  `qv_bytes_free` のちょうど1回。
- `QvEncoder` ハンドルは `qv_encoder_finalize` か `qv_encoder_free`
  のどちらか一方で解放し、二重解放はしない。

## 5. ビルド形態

- クレート名 `voice2qr-core`。`crate-type = ["rlib", "cdylib", "staticlib"]`。
- 配置：

```
core/
  Cargo.toml
  include/qv.h
  src/lib.rs      （公開面の再エクスポート）
  src/qv.rs       （qv 層）
  src/codec.rs    （codec 層： trait と LibCodec2）
  src/engine.rs   （engine 層）
  src/ffi.rs      （C ABI）
  tests/golden.rs （ゴールデンテスト）
```

- Web： コアを wasm の cdylib としてビルドし、C ABI の export を
  JS の薄いグルーから呼ぶ。Codec2 は無改造の C ソースから別 wasm
  モジュールとしてビルドし、コア側の import をその export で満たす
  （LGPL の分離をファイル単位で保つ）。
- Android： コアを .so 化し、Kotlin の薄い JNI ラッパから呼ぶ。
  Codec2 は別 .so として同梱する。

## 6. テスト戦略

- **ゴールデンテスト（必須、CI）**： `fixtures/` の v2 フィクスチャと
  バイト単位で照合する。スパイクの原音声 PCM を符号化したフレーム列が
  既知の正解と一致すること、復号 PCM がスパイクの復号結果と一致する
  こと。符号化は決定的（同じ入力 → 同じ出力）であるため、この照合が
  互換性の錨になる。
  - 復号の注意（2026-11-14 実装時に判明）： libcodec2 の位相モデルと
    ポストフィルタはプロセス全体で共有される PRNG
    （`codec2_rand()`、sine.c の static 変数）からランダム位相を引く。
    符号化はこれを消費しないが、復号は進めるため、**バイト単位で
    再現するのはプロセス内で最初の復号だけ**で、以降の復号は
    ランダム位相成分がわずかに異なる（聞き分けはできない差）。
    このためゴールデンテストの復号照合は、子プロセスで単独に
    復号して行う。CI ではバイナリフィクスチャの代わりに
    `fixtures/expected/` のテキストアンカー（決定的な合成信号に
    対する期待ペイロードと参照復号 PCM）を使う。
  - 復号 PCM の照合は許容誤差つきとする（2026-11-14 の CI で判明）：
    復号サンプルは量子化されない浮動小数点の結果であり、libm や
    コンパイラなど浮動小数点環境の差で LSB 単位のずれが出る
    （実測： -O0 / -Ofast ビルドはビット一致、-ffast-math ビルドで
    最大 41 LSB のずれ。構造的に誤った復号は数千 LSB の差になる）。
    閾値は最大絶対差 512、平均絶対差 8。バイト単位の契約は
    QR が運ぶ符号化ビット列の側にある。
- **単体テスト**： セクション走査（未知セクションの読み飛ばし、
  長さ溢れで Malformed、VOICE 複数時は先頭採用、TEXT / IMAGE の
  検出）、parse ∘ build の往復一致。
- **往復の注意**： Codec2 は非可逆圧縮なので decode(encode(pcm)) は
  元 PCM と一致しない。一致を要求するのは「符号化の決定性」と
  「フォーマットの往復」だけである。
