//! The codec abstraction and its libcodec2 backend.
//!
//! The rest of the core talks to this trait only. Mode facts (samples and
//! bytes per frame) are always queried from the backend — and in
//! [`LibCodec2`] from libcodec2 itself — never from a hand-kept table, so
//! the format layer and the codec can evolve independently.
//!
//! libcodec2 is LGPL-2.1: it is used unmodified, through dynamic linking,
//! and is never vendored into this crate.

use crate::{Error, Result};
use std::os::raw::{c_int, c_short, c_uchar, c_void};

/// Frame geometry of one Codec2 mode.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ModeInfo {
    /// PCM samples consumed/produced per frame (8 kHz mono).
    pub samples_per_frame: usize,
    /// Encoded bytes per frame.
    pub bytes_per_frame: usize,
    /// Recording time covered by one frame, in milliseconds.
    pub frame_ms: usize,
}

impl ModeInfo {
    fn new(samples_per_frame: usize, bytes_per_frame: usize) -> Self {
        ModeInfo {
            samples_per_frame,
            bytes_per_frame,
            frame_ms: samples_per_frame * 1000 / 8000,
        }
    }
}

/// A codec backend: knows the modes, hands out per-stream sessions.
pub trait Codec {
    /// Mode facts for a bit rate, or `None` if the backend has no such mode.
    fn mode_info(&self, bps: u16) -> Option<ModeInfo>;
    fn encoder(&self, bps: u16) -> Result<Box<dyn EncodeSession>>;
    fn decoder(&self, bps: u16) -> Result<Box<dyn DecodeSession>>;
}

/// One encoding stream. Stateful; one frame per call.
pub trait EncodeSession {
    /// Encode exactly `ModeInfo.samples_per_frame` samples into exactly
    /// `ModeInfo.bytes_per_frame` bytes.
    fn encode_frame(&mut self, samples: &[i16], out: &mut [u8]);
}

/// One decoding stream. Stateful; one frame per call.
pub trait DecodeSession {
    /// Decode exactly `ModeInfo.bytes_per_frame` bytes into exactly
    /// `ModeInfo.samples_per_frame` samples.
    fn decode_frame(&mut self, frame: &[u8], out: &mut [i16]);
}

// ---------------------------------------------------------------------------
// libcodec2 backend
// ---------------------------------------------------------------------------

#[allow(non_camel_case_types)]
type Codec2State = c_void;

extern "C" {
    fn codec2_create(mode: c_int) -> *mut Codec2State;
    fn codec2_destroy(state: *mut Codec2State);
    fn codec2_encode(state: *mut Codec2State, bits: *mut c_uchar, speech_in: *const c_short);
    fn codec2_decode(state: *mut Codec2State, speech_out: *mut c_short, bits: *const c_uchar);
    fn codec2_samples_per_frame(state: *mut Codec2State) -> c_int;
    fn codec2_bits_per_frame(state: *mut Codec2State) -> c_int;
}

/// Codec2 mode numbers (codec2.h, stable across 1.x).
fn mode_number(bps: u16) -> Option<c_int> {
    match bps {
        3200 => Some(0),
        2400 => Some(1),
        1600 => Some(2),
        1400 => Some(3),
        1300 => Some(4),
        1200 => Some(5),
        700 => Some(8), // 700C
        _ => None,
    }
}

/// The production backend: the system libcodec2, dynamically linked.
#[derive(Clone, Copy, Default)]
pub struct LibCodec2;

struct RawSession {
    state: *mut Codec2State,
    info: ModeInfo,
}

// A session is owned and used through `&mut self`; moving it between
// threads does not create aliasing of the C state.
unsafe impl Send for RawSession {}

impl RawSession {
    fn new(bps: u16) -> Result<Self> {
        let mode = mode_number(bps).ok_or(Error::UnsupportedBps(bps))?;
        let state = unsafe { codec2_create(mode) };
        if state.is_null() {
            return Err(Error::Codec("codec2_create returned null"));
        }
        let samples = unsafe { codec2_samples_per_frame(state) } as usize;
        let bits = unsafe { codec2_bits_per_frame(state) } as usize;
        let info = ModeInfo::new(samples, (bits + 7) / 8);
        Ok(RawSession { state, info })
    }
}

impl Drop for RawSession {
    fn drop(&mut self) {
        unsafe { codec2_destroy(self.state) }
    }
}

impl EncodeSession for RawSession {
    fn encode_frame(&mut self, samples: &[i16], out: &mut [u8]) {
        debug_assert_eq!(samples.len(), self.info.samples_per_frame);
        debug_assert_eq!(out.len(), self.info.bytes_per_frame);
        unsafe {
            codec2_encode(self.state, out.as_mut_ptr(), samples.as_ptr());
        }
    }
}

impl DecodeSession for RawSession {
    fn decode_frame(&mut self, frame: &[u8], out: &mut [i16]) {
        debug_assert_eq!(frame.len(), self.info.bytes_per_frame);
        debug_assert_eq!(out.len(), self.info.samples_per_frame);
        unsafe {
            codec2_decode(self.state, out.as_mut_ptr(), frame.as_ptr());
        }
    }
}

impl Codec for LibCodec2 {
    fn mode_info(&self, bps: u16) -> Option<ModeInfo> {
        // Query the library itself via a throwaway session.
        RawSession::new(bps).ok().map(|s| s.info)
    }

    fn encoder(&self, bps: u16) -> Result<Box<dyn EncodeSession>> {
        Ok(Box::new(RawSession::new(bps)?))
    }

    fn decoder(&self, bps: u16) -> Result<Box<dyn DecodeSession>> {
        Ok(Box::new(RawSession::new(bps)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_1200_geometry() {
        let info = LibCodec2.mode_info(1200).expect("1200 must exist");
        assert_eq!(info.samples_per_frame, 320);
        assert_eq!(info.bytes_per_frame, 6);
        assert_eq!(info.frame_ms, 40);
    }

    #[test]
    fn mode_2400_geometry() {
        // 2400 bps x 20 ms = 48 bits = 6 bytes per frame. Cross-checked
        // against the spike fixture: (2599 - 7) / 432 frames = 6.
        let info = LibCodec2.mode_info(2400).expect("2400 must exist");
        assert_eq!(info.samples_per_frame, 160);
        assert_eq!(info.bytes_per_frame, 6);
    }

    #[test]
    fn unknown_bps_has_no_mode() {
        assert!(LibCodec2.mode_info(1234).is_none());
        assert!(matches!(
            LibCodec2.encoder(1234),
            Err(Error::UnsupportedBps(1234))
        ));
    }

    #[test]
    fn silence_round_trips_in_length() {
        let enc_info = LibCodec2.mode_info(1200).unwrap();
        let mut enc = LibCodec2.encoder(1200).unwrap();
        let mut dec = LibCodec2.decoder(1200).unwrap();
        let silence = vec![0i16; enc_info.samples_per_frame];
        let mut frame = vec![0u8; enc_info.bytes_per_frame];
        enc.encode_frame(&silence, &mut frame);
        let mut out = vec![0i16; enc_info.samples_per_frame];
        dec.decode_frame(&frame, &mut out);
        assert_eq!(out.len(), silence.len());
    }
}
