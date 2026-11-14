//! Shared test utilities, included by both `core/tests/golden.rs` and
//! `core/examples/gen_ci_fixtures.rs` via `#[path]` — keep one copy here.
//!
//! The generator below uses integer-only arithmetic on purpose: the
//! golden anchors must be bit-identical on every platform and compiler,
//! which rules out libm transcendentals (sin/cos) in the signal itself.

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
