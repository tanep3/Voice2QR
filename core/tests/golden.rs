//! Golden tests: the core must reproduce, byte for byte, the results the
//! 2026-11-14 spike verified against libcodec2 (see `docs/requirements.md`
//! §7 and `fixtures/README.md`).
//!
//! Anchors:
//! - The Codec2 frames inside the v2 fixture must equal the frames inside
//!   the spike's v1 fixture (`fixtures/payload_1200.bin`) — the encoder is
//!   the same deterministic libcodec2, only the container changed.
//! - Decoding the v2 fixture must reproduce the spike's decoded PCM
//!   (`fixtures/golden_decoded_1200.wav`) exactly.

use std::path::PathBuf;
use voice2qr_core::codec::LibCodec2;
use voice2qr_core::engine;
use voice2qr_core::qv::{Payload, QR_CAPACITY_M};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures")
}

fn read_wav_pcm(path: &PathBuf) -> Vec<i16> {
    let data = std::fs::read(path).expect("read wav");
    let mut off = 12usize;
    loop {
        let id = &data[off..off + 4];
        let size =
            u32::from_le_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]]) as usize;
        if id == b"data" {
            return data[off + 8..off + 8 + size]
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
        }
        off += 8 + size + (size % 2);
    }
}

/// Frames of the spike's v1 payload: 7-byte header, then raw frames.
fn v1_fixture_frames() -> (u16, u16, Vec<u8>) {
    let b = std::fs::read(fixtures().join("payload_1200.bin")).expect("read v1 fixture");
    assert_eq!(&b[0..2], b"QV");
    assert_eq!(b[2], 1);
    let bps = u16::from_le_bytes([b[3], b[4]]);
    let frames = u16::from_le_bytes([b[5], b[6]]);
    (bps, frames, b[7..].to_vec())
}

#[test]
fn encoder_matches_spike_frames() {
    let (bps, frame_count, spike_frames) = v1_fixture_frames();
    assert_eq!(bps, 1200);
    let pcm = read_wav_pcm(&fixtures().join("golden_source_8k.wav"));
    let payload = engine::encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).unwrap();
    let parsed = Payload::parse(&payload).unwrap();
    let voice = parsed.voice().unwrap();
    assert_eq!(voice.frame_count, frame_count);
    assert_eq!(voice.frames, spike_frames, "frames must match the spike byte for byte");
}

#[test]
fn v2_fixture_is_stable() {
    // Regenerating the payload from the source must reproduce the stored
    // v2 fixture exactly (the fixture is produced by examples/gen_fixture).
    let stored = std::fs::read(fixtures().join("payload_v2_1200.bin")).expect("read v2 fixture");
    let pcm = read_wav_pcm(&fixtures().join("golden_source_8k.wav"));
    let payload = engine::encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).unwrap();
    assert_eq!(payload, stored);
    // 8.64 s at 1200 bps: 1,296 frame bytes + 10 overhead = 1,306 bytes.
    assert_eq!(stored.len(), 1306);
}

#[test]
fn decoder_matches_spike_pcm() {
    let stored = std::fs::read(fixtures().join("payload_v2_1200.bin")).expect("read v2 fixture");
    let decoded = engine::decode(&LibCodec2, &stored).unwrap();
    let expected = read_wav_pcm(&fixtures().join("golden_decoded_1200.wav"));
    assert_eq!(decoded, expected, "decoded PCM must match the spike byte for byte");
}

#[test]
fn inspect_reports_spike_values() {
    let stored = std::fs::read(fixtures().join("payload_v2_1200.bin")).expect("read v2 fixture");
    let info = engine::inspect(&LibCodec2, &stored).unwrap();
    let v = info.voice.expect("voice present");
    assert_eq!(v.bps, 1200);
    assert_eq!(v.frame_count, 216);
    assert_eq!(v.duration_ms, 8640);
    assert!(!info.has_text && !info.has_image);
}
