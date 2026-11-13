# Voice2QR

**本人の声そのものを、QRコードの中に記録する。**

Voice2QR は、録音した声を QR コードに格納し、読み取ればネットワーク
なしでその場で再生できるアプリ／フォーマットです。

リンクでもテキストでもありません。QR の中に入っているのは声そのものです。

## 何ができるか

- 1個の QR コードに、最大で約15秒の声を記録できます
- QR を印刷して紙に残せます。手紙や年賀状、ノートに貼った声が、スマホを
  かざすだけで再生されます
- 記録も再生も、すべて手元の端末の中で完結します。サーバーもアカウントも
  要りません

## なぜ声が QR に入るのか

音声波形そのものは QR に入りません。Voice2QR はボコーダ（Codec2）で声の
特徴をパラメータ化して記録します。波形ではなく声の「設計図」を残すから
こそ、1,200 bps という細さで約15秒の声が1個の QR に収まります。

テキスト＋読み上げ（TTS）方式は採用しません。テキストは「何を言ったか」
しか残せず、誰がどう喋ったか — 本人の声 — は消えてしまうからです。

QR の誤り訂正はレベル M。紙に印刷して多少傷んでも読めることを優先して
います。描画はモジュールの整数倍拡大で、印刷でも滲みません。

## アプリ

1つのフォーマットを、2つのアプリが共有します。

- **PC** — 録音、QR の生成と画像保存、感熱プリンタへの印刷
- **スマートフォン** — その場で録音して QR を表示、紙の QR をカメラで
  読んで即再生（ネットワーク機能を持ちません）

## フォーマットと検証コード

データフォーマット「QV」の仕様は `docs/format.md` にあります。
方式の検証コードと照合用データは `spike/` と `fixtures/` にあります
（音声 → 符号化 → QR 生成 → 生成画像の読み戻しでバイト列が完全一致し、
復号した声が聞き取れることを確認済みです）。

## ライセンス

Voice2QR のコードは MIT License です（`LICENSE`）。

ただし Codec2 は **LGPL-2.1** の別コンポーネントであり、MIT の対象では
ありません。本プロジェクトでは Codec2 を無改造・別ライブラリとして
利用します。詳細は `THIRD_PARTY_NOTICES.md` と `third_party/codec2/` を
参照してください。

## English summary

Voice2QR records a real human voice *itself* — not a link, not text — inside
a QR code. The voice is parameterized with the Codec2 speech codec at
1,200 bit/s and stored in the QR code's byte mode with error correction
level M: about 15 seconds of voice per code. Print the code on paper, scan
it, and the voice plays back — fully offline, no server, no account.
PC and smartphone apps share one format (`docs/format.md`). Voice2QR code
is MIT-licensed; Codec2 is a separate LGPL-2.1 component (see
`THIRD_PARTY_NOTICES.md`).
