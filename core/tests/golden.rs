//! Golden tests: the core must reproduce, byte for byte, the results the
//! 2026-11-14 spike verified against libcodec2 (see `docs/requirements.md`
//! §7 and `fixtures/README.md`).
//!
//! Two tiers:
//! - **CI anchors** (`fixtures/expected/`, plain text, in git): a
//!   deterministic synthetic signal whose expected payload (hex) and
//!   reference decoded PCM (hex) were recorded against the pinned
//!   Codec2 1.2.0. These run everywhere, including CI, with no binary
//!   fixture files. Regenerate with `core/examples/gen_ci_fixtures.rs`.
//! - **Local evidence tier** (binary fixtures, not in git): the spike's
//!   real-voice files. The Codec2 frames inside the v2 fixture must equal
//!   the frames inside the spike's v1 fixture (`payload_1200.bin`), and
//!   decoding must reproduce the spike's PCM within the tolerance below.
//!   These tests skip when the files are absent (e.g. in CI).
//!
//! Why decodes run in a fresh child process: libcodec2's phase model and
//! postfilter draw random phases from a process-global PRNG
//! (`codec2_rand()` in sine.c — a static the upstream code itself flags
//! with a "should probably be in some states" todo). Encoding never
//! consumes it and is a pure function of the input, but every decode
//! advances it, so only the FIRST decode in a process reproduces the
//! reference PCM byte for byte; later decodes differ in the
//! randomized-phase components (inaudible, but not byte-identical).
//! Decode checks therefore spawn this test binary as a child running a
//! single decode (see `golden_decode_child`).
//!
//! Why decoded PCM is compared with a tolerance, not byte-exactly:
//! decoded samples are unquantized float results and drift at the LSB
//! level across floating-point environments (libm / compiler). Measured
//! 2026-11-14: -O0 and -Ofast builds reproduce the reference decode
//! bit-for-bit, a -ffast-math build drifts by at most 41 LSB (mean
//! 0.49), while a structurally wrong decode (e.g. shifted PRNG state)
//! differs by thousands of LSB. The thresholds below sit far above the
//! first group and far below the second. The byte-exact contract of
//! this project is the ENCODED bitstream — that is what a QR carries.

#[path = "../testutil/shared.rs"]
mod shared;

use std::path::PathBuf;
use voice2qr_core::codec::LibCodec2;
use voice2qr_core::engine;
use voice2qr_core::qv::{Payload, QR_CAPACITY_M};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures")
}

fn binary_fixture(name: &str) -> Option<Vec<u8>> {
    std::fs::read(fixtures().join(name)).ok()
}

fn wav_pcm(data: &[u8]) -> Vec<i16> {
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

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim();
    assert!(s.len() % 2 == 0, "hex string must have even length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex digit"))
        .collect()
}

// ---------------------------------------------------------------------------
// Fresh-process decoding (see the module note on codec2_rand)
// ---------------------------------------------------------------------------

const CHILD_OUT_ENV: &str = "QV_GOLDEN_CHILD_OUT";
const CHILD_PAYLOAD_ENV: &str = "QV_GOLDEN_CHILD_PAYLOAD";

/// Child-mode entry point: when spawned by `decode_in_fresh_process`, the
/// environment names a payload file to decode (as this process's first
/// decode) and an output file for the PCM. In a normal test run the
/// environment is unset and this test passes without doing anything.
#[test]
fn golden_decode_child() {
    let Ok(out_path) = std::env::var(CHILD_OUT_ENV) else { return };
    let payload = std::fs::read(std::env::var(CHILD_PAYLOAD_ENV).unwrap()).unwrap();
    let pcm = engine::decode(&LibCodec2, &payload).unwrap();
    let mut le = Vec::with_capacity(pcm.len() * 2);
    for s in &pcm {
        le.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(out_path, le).unwrap();
}

/// Decode in a freshly spawned copy of this test binary, so the decode
/// is the first one in that process and byte-comparable to references.
fn decode_in_fresh_process(payload: &[u8]) -> Vec<i16> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let tag = format!(
        "qv-golden-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let payload_path = std::env::temp_dir().join(format!("{tag}.payload"));
    let out_path = std::env::temp_dir().join(format!("{tag}.pcm"));
    std::fs::write(&payload_path, payload).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["golden_decode_child", "--exact", "--test-threads=1"])
        .env(CHILD_OUT_ENV, &out_path)
        .env(CHILD_PAYLOAD_ENV, &payload_path)
        .status()
        .unwrap();
    assert!(status.success(), "child decode process failed");
    let le = std::fs::read(&out_path).unwrap();
    let _ = std::fs::remove_file(&payload_path);
    let _ = std::fs::remove_file(&out_path);
    le.chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

// ---------------------------------------------------------------------------
// CI anchors
// ---------------------------------------------------------------------------

/// Decode comparison thresholds (see the module note): far above
/// floating-point environment drift, far below structural errors.
const DECODE_MAX_ABS_DIFF: i32 = 512;
const DECODE_MEAN_ABS_DIFF: f64 = 8.0;

fn assert_pcm_close(context: &str, actual: &[i16], expected: &[i16]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: sample count differs ({} vs {})",
        actual.len(),
        expected.len()
    );
    let mut max_diff: i32 = 0;
    let mut sum: u64 = 0;
    for (a, b) in actual.iter().zip(expected) {
        let d = (*a as i32 - *b as i32).abs();
        max_diff = max_diff.max(d);
        sum += d as u64;
    }
    let mean = sum as f64 / actual.len().max(1) as f64;
    assert!(
        max_diff <= DECODE_MAX_ABS_DIFF && mean <= DECODE_MEAN_ABS_DIFF,
        "{context}: decoded PCM drifted too far (max |diff| {max_diff}, mean {mean:.2}); \
         thresholds are {DECODE_MAX_ABS_DIFF} / {DECODE_MEAN_ABS_DIFF}"
    );
}

fn le_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

#[test]
fn synthetic_signal_matches_ci_anchors() {
    let expected_payload = unhex(
        &std::fs::read_to_string(fixtures().join("expected/synthetic_1200_payload.hex"))
            .expect("read payload anchor"),
    );
    let expected_pcm = le_i16(&unhex(
        &std::fs::read_to_string(fixtures().join("expected/synthetic_1200_decoded.hex"))
            .expect("read decoded anchor"),
    ));

    // Encoding the deterministic signal must reproduce the payload that
    // the pinned Codec2 1.2.0 produced when the anchor was recorded.
    let pcm = shared::synthetic_pcm();
    let payload = engine::encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).unwrap();
    assert_eq!(payload, expected_payload, "encoder output drifted from the Codec2 1.2.0 anchor");

    // Decoding the anchored payload must reproduce the reference PCM
    // within floating-point tolerance. (Fresh process: the first decode
    // is the reference decode — see the module note on codec2_rand.)
    let decoded = decode_in_fresh_process(&expected_payload);
    assert_pcm_close("synthetic anchor", &decoded, &expected_pcm);
}

// ---------------------------------------------------------------------------
// Local evidence tier (spike fixtures; skipped when absent)
// ---------------------------------------------------------------------------

/// Frames of the spike's v1 payload: 7-byte header, then raw frames.
fn v1_fixture_frames(b: &[u8]) -> (u16, u16, Vec<u8>) {
    assert_eq!(&b[0..2], b"QV");
    assert_eq!(b[2], 1);
    let bps = u16::from_le_bytes([b[3], b[4]]);
    let frames = u16::from_le_bytes([b[5], b[6]]);
    (bps, frames, b[7..].to_vec())
}

#[test]
fn encoder_matches_spike_frames() {
    let (Some(v1), Some(source)) =
        (binary_fixture("payload_1200.bin"), binary_fixture("golden_source_8k.wav"))
    else {
        eprintln!("skip: spike fixtures not present (local evidence tier)");
        return;
    };
    let (bps, frame_count, spike_frames) = v1_fixture_frames(&v1);
    assert_eq!(bps, 1200);
    let payload = engine::encode(LibCodec2, &wav_pcm(&source), 1200, QR_CAPACITY_M).unwrap();
    let parsed = Payload::parse(&payload).unwrap();
    let voice = parsed.voice().unwrap();
    assert_eq!(voice.frame_count, frame_count);
    assert_eq!(voice.frames, spike_frames, "frames must match the spike byte for byte");
}

#[test]
fn v2_fixture_is_stable() {
    // Regenerating the payload from the source must reproduce the stored
    // v2 fixture exactly (the fixture is produced by examples/gen_fixture).
    let (Some(stored), Some(source)) =
        (binary_fixture("payload_v2_1200.bin"), binary_fixture("golden_source_8k.wav"))
    else {
        eprintln!("skip: v2 fixture not present (local evidence tier)");
        return;
    };
    let payload = engine::encode(LibCodec2, &wav_pcm(&source), 1200, QR_CAPACITY_M).unwrap();
    assert_eq!(payload, stored);
    // 8.64 s at 1200 bps: 1,296 frame bytes + 10 overhead = 1,306 bytes.
    assert_eq!(stored.len(), 1306);
}

#[test]
fn decoder_matches_spike_pcm() {
    let (Some(stored), Some(expected_wav)) = (
        binary_fixture("payload_v2_1200.bin"),
        binary_fixture("golden_decoded_1200.wav"),
    ) else {
        eprintln!("skip: spike fixtures not present (local evidence tier)");
        return;
    };
    let decoded = decode_in_fresh_process(&stored);
    assert_pcm_close("spike PCM", &decoded, &wav_pcm(&expected_wav));
}

#[test]
fn inspect_reports_spike_values() {
    let Some(stored) = binary_fixture("payload_v2_1200.bin") else {
        eprintln!("skip: v2 fixture not present (local evidence tier)");
        return;
    };
    let info = engine::inspect(&LibCodec2, &stored).unwrap();
    let v = info.voice.expect("voice present");
    assert_eq!(v.bps, 1200);
    assert_eq!(v.frame_count, 216);
    assert_eq!(v.duration_ms, 8640);
    assert!(!info.has_text && !info.has_image);
}
