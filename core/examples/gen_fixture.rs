//! Generate the v2 golden fixture: encode `fixtures/golden_source_8k.wav`
//! at 1200 bps and write `fixtures/payload_v2_1200.bin`.
//!
//! Run from the repository root:
//!   cargo run --example gen_fixture --manifest-path core/Cargo.toml

use std::path::PathBuf;
use voice2qr_core::codec::LibCodec2;
use voice2qr_core::engine;
use voice2qr_core::qv::QR_CAPACITY_M;

fn read_wav_pcm(path: &PathBuf) -> Vec<i16> {
    let data = std::fs::read(path).expect("read wav");
    // Minimal RIFF walk: find the "data" chunk. Assumes 16-bit PCM.
    let mut off = 12usize;
    loop {
        let id = &data[off..off + 4];
        let size = u32::from_le_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]]) as usize;
        if id == b"data" {
            return data[off + 8..off + 8 + size]
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
        }
        off += 8 + size + (size % 2);
    }
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let pcm = read_wav_pcm(&root.join("fixtures/golden_source_8k.wav"));
    println!("source: {} samples ({:.2} s)", pcm.len(), pcm.len() as f64 / 8000.0);
    let payload = engine::encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).expect("encode");
    let out = root.join("fixtures/payload_v2_1200.bin");
    std::fs::write(&out, &payload).expect("write fixture");
    println!("wrote {} ({} bytes)", out.display(), payload.len());
}
