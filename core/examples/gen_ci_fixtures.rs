//! Generate the CI golden anchors (text files, committable through the
//! usual text-only routes):
//!   fixtures/expected/synthetic_1200_payload.hex   — expected QV payload
//!     for the deterministic synthetic signal at 1200 bps / capacity M
//!   fixtures/expected/synthetic_1200_decoded.sha256 — SHA-256 of the
//!     decoded PCM (little-endian int16 bytes)
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

    let decoded = engine::decode(&LibCodec2, &payload).expect("decode");
    let mut le = Vec::with_capacity(decoded.len() * 2);
    for s in &decoded {
        le.extend_from_slice(&s.to_le_bytes());
    }
    let digest = shared::sha256_hex(&le);
    std::fs::write(dir.join("synthetic_1200_decoded.sha256"), format!("{digest}\n"))
        .expect("write decoded anchor");
    println!("decoded anchor: {digest} ({} samples)", decoded.len());
}
