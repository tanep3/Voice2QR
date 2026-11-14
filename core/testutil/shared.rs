//! Shared test utilities, included by both `core/tests/golden.rs` and
//! `core/examples/gen_ci_fixtures.rs` via `#[path]` — keep one copy here.
//!
//! Everything here is integer-only arithmetic on purpose: the golden
//! anchors must be bit-identical on every platform and compiler, which
//! rules out libm transcendentals (sin/cos) in the signal generator and
//! any external dependency in the hash.

// ---------------------------------------------------------------------------
// Deterministic synthetic test signal
// ---------------------------------------------------------------------------

/// One second (8000 samples) of speech-like PCM, generated with integer
/// math only: a harmonic stack (triangle waves) whose fundamental glides
/// from 100 Hz to ~150 Hz, gated in 200 ms blocks like syllables, plus
/// xorshift noise. Not a recording — a stable input whose encoded form is
/// a regression anchor.
pub fn synthetic_pcm() -> Vec<i16> {
    let mut pcm = Vec::with_capacity(8000);
    let mut rng: u32 = 0x1234_5678;
    let mut phase: u32 = 0; // position within the cycle, 16.16 fixed point
    for n in 0..8000usize {
        // Fundamental period glides 80 -> 53 samples (100 Hz -> ~151 Hz).
        let period = 80u32 - (27 * n as u32) / 8000;
        phase = phase.wrapping_add(0x1_0000 / period);
        // Sum triangle waves for harmonics 1..=6, amplitude ~ 1/(2k).
        let mut v: i32 = 0;
        for k in 1..=6u32 {
            let p = phase.wrapping_mul(k) & 0xFFFF;
            let tri = if p < 0x8000 {
                p as i32 * 2 - 0x8000
            } else {
                0x1_8000 - p as i32 * 2
            };
            v += tri / (k as i32 * 2);
        }
        // Envelope: 200 ms gates alternate full / reduced gain, and the
        // first 10 ms ramp up to avoid a click.
        let gate = if (n / 1600) % 2 == 0 { 100 } else { 35 };
        let attack = if n < 80 { (n as i32) * 100 / 80 } else { 100 };
        v = v * gate / 100 * attack / 100;
        // Noise bed.
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let noise = ((rng >> 16) as i32 - 0x8000) / 16;
        pcm.push((v / 8 + noise).clamp(-32768, 32767) as i16);
    }
    pcm
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), compact reference implementation
// ---------------------------------------------------------------------------

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Lowercase hex SHA-256 digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    // Pad: message || 0x80 || zeros || 64-bit big-endian bit length.
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        out.push_str(&format!("{word:08x}"));
    }
    out
}
