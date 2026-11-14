//! Generate the CI golden anchors (text files, committable through the
//! usual text-only routes):
//!   fixtures/expected/synthetic_1200_payload.hex   — expected QV payload
//!     for the deterministic synthetic signal at 1200 bps / capacity M
//!   fixtures/expected/synthetic_1200_decoded.hex   — reference decoded
//!     PCM (little-endian int16 bytes, hex). Decoded PCM is compared
//!     with a tolerance, not byte-exactly: it varies at the LSB level
//!     across floating-point environments (see core/tests/golden.rs).
//!
//! Run from the repository root (needs libcodec2, like the core):
//!   cargo run --example gen_ci_fixtures --manifest-path core/Cargo.toml
//!
//! Anchors are only meaningful against the pinned Codec2 (1.2.0). If a
//! Codec2 upgrade ever changes the bitstream, regenerate the anchors
//! deliberately and record the change — never to silence a red test.

#[path = "../testutil/shared.rs"]
mod shared;

use std::path::PathBuf;
use voice2qr_core::codec::LibCodec2;
use voice2qr_core::engine;
use voice2qr_core::qv::QR_CAPACITY_M;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = root.join("fixtures/expected");
    std::fs::create_dir_all(&dir).expect("create expected dir");

    let pcm = shared::synthetic_pcm();
    let payload = engine::encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).expect("encode");
    std::fs::write(dir.join("synthetic_1200_payload.hex"), format!("{}\n", hex(&payload)))
        .expect("write payload anchor");
    println!("payload anchor: {} bytes", payload.len());

    // This decode is the process's first (encoding consumes no
    // codec2_rand), so it is the reference decode.
    let decoded = engine::decode(&LibCodec2, &payload).expect("decode");
    let mut le = Vec::with_capacity(decoded.len() * 2);
    for s in &decoded {
        le.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(dir.join("synthetic_1200_decoded.hex"), format!("{}\n", hex(&le)))
        .expect("write decoded anchor");
    println!("decoded anchor: {} samples", decoded.len());
}
