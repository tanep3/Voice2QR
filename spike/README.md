# Spike (2026-11-14 verification prototype)

One-off verification scripts that proved the Voice2QR pipeline end to end on
PC before the project was started. They are the reference for the format
in `docs/format.md`, not production code.

- `codec2_qr.py` — Codec2 2400 encode/decode via libcodec2 (ctypes),
  builds the QV payload.
- `codec2_1200.py` — same pipeline at the settled 1200 bps mode, QR
  generation and side-by-side comparison data.
- `qr_roundtrip.py` — scan-back verification with zxing-cpp: the bytes
  read from the generated QR image matched the payload exactly, and the
  PCM decoded from the scanned bytes matched the direct decode.

Verified results (VOICEVOX sample voice, 8.64 s):
- 2400 bps: 2,592 bytes -> QR Version 38 (error level L)
- 1200 bps: 1,296 bytes -> QR Version 26 (L) / Version 30 (M)

Runtime deps at spike time: system libcodec2 1.2, Python packages
`segno` (BSD) and `zxing-cpp` (Apache-2.0) — see `THIRD_PARTY_NOTICES.md`.
