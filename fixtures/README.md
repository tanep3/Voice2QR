# Verification fixtures (golden test data, 2026-11-14 spike)

Reference data from the verified spike, for checking an implementation
against known-good values. Source voice: VOICEVOX Hamine Ritsu reading a
fixed test sentence, 8.64 s, 8 kHz mono.

- `payload_1200.bin` — the exact QV **v1** payload from the spike:
  7-byte header ("QV", ver 1, bps 1200, 216 frames) + 1,296 bytes of
  Codec2 frames = **1,303 bytes**. The format has since been revised
  to v2 (section-based; see `docs/format.md`) before any release, so
  golden fixtures will be regenerated in v2 when the core is built.
  The Codec2 frames are unchanged: a v2 payload for the same source
  is 1,306 bytes and still fits QR Version 30 at error level M.
- `payload_2400.bin` — same voice at 2400 bps (2,599 bytes, 432 frames),
  kept as a reference for the rejected-for-print mode.
- `voice_qr_1200.png` — the QR image generated from `payload_1200.bin`
  (error level M). Scanning it back returned byte-identical data.
- `original_voice.mp3` — the source voice.
- `decoded_voice_1200.mp3` — the voice decoded from the scanned-back
  payload; identical to a direct decode of the original frames.
- `qr_compare.png` — 2400 (left) vs 1200 (right) at the same module
  scale, for print-size intuition.

Note on locations: the binary fixtures themselves (`.bin` / `.png` /
`.mp3`) are excluded from the Google Drive mirror of this folder, the
same way build artifacts are ignored in git. They live in the master
copy of this folder on Muse's development VM.
