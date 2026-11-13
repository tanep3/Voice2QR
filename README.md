# Voice2QR

**本人の声そのものを、QRコードの中に記録する。**

Voice2QR は、録音した声を音声コーデック Codec2 でパラメータ化し、そのデータ
自体を QR コードに格納するアプリ／フォーマットのプロジェクトです。
QR を読み取れば、ネットワークなしでその場で声が再生されます。

リンクでもテキストでもありません。QR の中に入っているのは声そのものです。

- テキスト＋読み上げ（TTS）方式は採用しません。テキストは「何を言ったか」
  しか残せず、誰がどう喋ったか（本人の声）は消えてしまうからです。
- 音声波形そのものは QR に入りません。声の特徴を抽出するボコーダ
  （Codec2）で記録するからこそ、1個の QR に約15秒の声が収まります。

## 方式の要点（決定事項）

| 項目 | 決定 |
|---|---|
| 音声コーデック | Codec2 **1200 bps**（40ms / 48bit フレーム） |
| QR 誤り訂正 | **レベル M**（紙への印刷を前提に耐久性優先） |
| 記録時間 | 1個の QR で最大約15.5秒（訂正M の容量 2,331 バイト） |
| サンプリング | 8 kHz モノラル固定 |
| ネットワーク | 不使用。録音・符号化・生成・読取・復号・再生すべて端末内 |
| 印刷描画 | モジュール整数倍拡大、アンチエイリアスなし |

データフォーマットの詳細は `docs/format.md` を参照。

## アプリ構成（計画）

1つのフォーマットと1つのコアを、2つのアプリが共有します。

- **PCアプリ（工房）**：録音／取込、QR 生成・画像保存、CUPS 経由で
  感熱プリンタ（Phomemo M02S 想定）へ直接印刷、アーカイブ管理。
  QR の読取は画像ファイルと Web カメラの両対応。
- **スマホアプリ（現場の機械）**：その場で録音して QR 表示、紙の QR を
  カメラで読んで即再生。画像ファイルからの読取も対応。印刷は OS の
  共有機能で Phomemo アプリへ転送する方式を第一とする。完全スタンド
  アロン（ネットワーク機能なし）。

## 開発状況

- 2026-11-14：方式スパイク検証完了（`spike/`）。
  音声 → Codec2 符号化 → QR 生成 → QR 画像の読み戻し → バイト列完全一致
  → 復号音声まで、PC 上で一貫動作を確認済み。
- アプリ本体は未着手。フォーマット仕様（`docs/format.md`）から着手する。

## ライセンス

Voice2QR のコードは MIT License です（`LICENSE`）。

ただし Codec2 は **LGPL-2.1** の別コンポーネントであり、MIT の対象では
ありません。本プロジェクトでは Codec2 を無改造・別ライブラリとして
利用します。詳細は `THIRD_PARTY_NOTICES.md` と `third_party/codec2/` を
参照してください。

## English summary

Voice2QR records a real human voice *itself* — not a link, not text — inside a
QR code, using the Codec2 speech codec at 1200 bit/s with QR error
correction level M (about 15 seconds of voice per code). Scanning the code
plays the voice back fully offline. PC and smartphone apps are planned
around one shared format (`docs/format.md`). Voice2QR code is MIT-licensed;
Codec2 is a separate LGPL-2.1 component (see `THIRD_PARTY_NOTICES.md`).
