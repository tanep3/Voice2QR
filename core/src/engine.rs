//! The engine: ties the format layer ([`crate::qv`]) to a codec backend
//! ([`crate::codec`]) and provides the operations the faces use —
//! inspection (observation, no data change), encoding, and decoding.

use crate::codec::{Codec, EncodeSession, ModeInfo};
use crate::qv::{Payload, Section, VoiceSection};
use crate::{Error, Result};

/// Bytes a voice-only payload adds around the frame data:
/// header (3) + section header (3) + VOICE subheader (4).
const VOICE_ONLY_OVERHEAD: usize = 10;

/// A summary of a payload's contents. Observation only.
#[derive(Clone, PartialEq, Debug)]
pub struct Info {
    pub version: u8,
    pub voice: Option<VoiceInfo>,
    pub has_text: bool,
    pub has_image: bool,
}

/// Facts about the VOICE section of a payload.
#[derive(Clone, PartialEq, Debug)]
pub struct VoiceInfo {
    pub bps: u16,
    pub frame_count: u16,
    /// Total voice duration. 0 if the bit rate is unknown to the codec
    /// (the duration cannot be derived without the mode's frame length).
    pub duration_ms: u32,
}

/// Inspect a payload without changing it.
pub fn inspect<C: Codec>(codec: &C, payload: &[u8]) -> Result<Info> {
    let p = Payload::parse(payload)?;
    let voice = p.voice().map(|v| {
        let duration_ms = codec
            .mode_info(v.bps)
            .map(|m| v.frame_count as u32 * m.frame_ms as u32)
            .unwrap_or(0);
        VoiceInfo { bps: v.bps, frame_count: v.frame_count, duration_ms }
    });
    Ok(Info {
        version: p.version,
        voice,
        has_text: p.sections.iter().any(|s| matches!(s, Section::Text(_))),
        has_image: p.sections.iter().any(|s| matches!(s, Section::Image(_))),
    })
}

/// Streaming encoder for recording: PCM arrives in arbitrary chunks and
/// is buffered to frame boundaries internally.
///
/// The encoder enforces `capacity` (the byte size the finished payload
/// must not exceed, e.g. a QR capacity): [`Encoder::push_pcm`] fails with
/// [`Error::PayloadTooLarge`] rather than produce an oversize payload.
pub struct Encoder<C: Codec> {
    /// The backend this encoder was created from. Kept so the encoder
    /// owns it for its whole life (a backend may hold resources its
    /// sessions draw on).
    _codec: C,
    session: Box<dyn EncodeSession>,
    mode: ModeInfo,
    bps: u16,
    capacity: usize,
    pending: Vec<i16>,
    frames: Vec<u8>,
    frame_count: u32,
}

impl<C: Codec> Encoder<C> {
    pub fn new(codec: C, bps: u16, capacity: usize) -> Result<Self> {
        let mode = codec.mode_info(bps).ok_or(Error::UnsupportedBps(bps))?;
        let session = codec.encoder(bps)?;
        Ok(Encoder {
            _codec: codec,
            session,
            mode,
            bps,
            capacity,
            pending: Vec::new(),
            frames: Vec::new(),
            frame_count: 0,
        })
    }

    /// The payload length if [`Encoder::finish`] were called now
    /// (counting a final zero-padded frame for any pending samples).
    pub fn payload_len(&self) -> usize {
        let partial = if self.pending.is_empty() { 0 } else { self.mode.bytes_per_frame };
        VOICE_ONLY_OVERHEAD + self.frames.len() + partial
    }

    /// Frames encoded so far (not counting a pending partial frame).
    pub fn frames_encoded(&self) -> u32 {
        self.frame_count
    }

    fn encode_one_frame(&mut self, samples: &[i16]) -> Result<()> {
        let projected = VOICE_ONLY_OVERHEAD + self.frames.len() + self.mode.bytes_per_frame;
        if projected > self.capacity {
            return Err(Error::PayloadTooLarge { len: projected, capacity: self.capacity });
        }
        let mut frame = vec![0u8; self.mode.bytes_per_frame];
        self.session.encode_frame(samples, &mut frame);
        self.frames.extend_from_slice(&frame);
        self.frame_count += 1;
        Ok(())
    }

    /// Add PCM samples (any count). Full frames are encoded immediately.
    pub fn push_pcm(&mut self, samples: &[i16]) -> Result<()> {
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= self.mode.samples_per_frame {
            let frame_samples: Vec<i16> =
                self.pending.drain(..self.mode.samples_per_frame).collect();
            self.encode_one_frame(&frame_samples)?;
        }
        Ok(())
    }

    /// Finish and return the QV payload. Leftover samples (less than one
    /// frame) are zero-padded into a final frame.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        if !self.pending.is_empty() {
            let mut last = std::mem::take(&mut self.pending);
            last.resize(self.mode.samples_per_frame, 0);
            self.encode_one_frame(&last)?;
        }
        if self.frame_count > u16::MAX as u32 {
            return Err(Error::InvalidArgument("recording too long for QV frame count"));
        }
        let payload = Payload::new_voice(VoiceSection {
            bps: self.bps,
            frame_count: self.frame_count as u16,
            frames: self.frames,
        });
        Ok(payload.build())
    }
}

/// One-shot encoding (file import): all PCM is available at once.
pub fn encode<C: Codec>(codec: C, pcm: &[i16], bps: u16, capacity: usize) -> Result<Vec<u8>> {
    let mut enc = Encoder::new(codec, bps, capacity)?;
    enc.push_pcm(pcm)?;
    enc.finish()
}

/// Decode a payload's VOICE section to 8 kHz mono PCM.
/// Other sections (TEXT, IMAGE, unknown) are skipped — this is what lets
/// a Voice2QR reader play just the voice of a multimedia payload.
///
/// Note: libcodec2's phase model draws random phases from a
/// process-global PRNG, so two decodes of the same payload in one
/// process can differ slightly in the randomized-phase components
/// (inaudible; the first decode in a process is the reference decode).
/// Encoding, by contrast, is a pure function of the input PCM.
pub fn decode<C: Codec>(codec: &C, payload: &[u8]) -> Result<Vec<i16>> {
    let p = Payload::parse(payload)?;
    let voice = p.voice().ok_or(Error::NoVoiceSection)?;
    let mode = codec.mode_info(voice.bps).ok_or(Error::UnsupportedBps(voice.bps))?;
    let expected = voice.frame_count as usize * mode.bytes_per_frame;
    if voice.frames.len() != expected {
        return Err(Error::Malformed("voice frame data length does not match frame count"));
    }
    let mut session = codec.decoder(voice.bps)?;
    let mut out = Vec::with_capacity(voice.frame_count as usize * mode.samples_per_frame);
    let mut buf = vec![0i16; mode.samples_per_frame];
    for frame in voice.frames.chunks_exact(mode.bytes_per_frame) {
        session.decode_frame(frame, &mut buf);
        out.extend_from_slice(&buf);
    }
    Ok(out)
}

/// The longest recording (ms) that fits `capacity` at this bit rate.
pub fn max_duration_ms<C: Codec>(codec: &C, bps: u16, capacity: usize) -> Result<u32> {
    let mode = codec.mode_info(bps).ok_or(Error::UnsupportedBps(bps))?;
    let frames_fit = capacity.saturating_sub(VOICE_ONLY_OVERHEAD) / mode.bytes_per_frame;
    Ok(frames_fit as u32 * mode.frame_ms as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::LibCodec2;
    use crate::qv::{ImageCodec, ImageSection, Payload, QR_CAPACITY_M};

    fn sine_pcm(ms: usize) -> Vec<i16> {
        let n = ms * 8; // 8 samples per ms at 8 kHz
        (0..n)
            .map(|i| {
                let t = i as f64 / 8000.0;
                (f64::sin(2.0 * std::f64::consts::PI * 440.0 * t) * 8000.0) as i16
            })
            .collect()
    }

    #[test]
    fn encode_decode_round_trip_shape() {
        let pcm = sine_pcm(200); // 5 frames at 1200 bps
        let payload = encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).unwrap();
        let parsed = Payload::parse(&payload).unwrap();
        let v = parsed.voice().unwrap();
        assert_eq!(v.bps, 1200);
        assert_eq!(v.frame_count, 5);
        assert_eq!(v.frames.len(), 30);
        let back = decode(&LibCodec2, &payload).unwrap();
        assert_eq!(back.len(), pcm.len());
        let info = inspect(&LibCodec2, &payload).unwrap();
        assert_eq!(info.voice.unwrap().duration_ms, 200);
    }

    #[test]
    fn capacity_is_enforced() {
        // 15.5 s fits M capacity at 1200 bps; 20 s does not.
        let ok = encode(LibCodec2, &sine_pcm(15_000), 1200, QR_CAPACITY_M);
        assert!(ok.is_ok());
        let ng = encode(LibCodec2, &sine_pcm(20_000), 1200, QR_CAPACITY_M);
        assert!(matches!(ng, Err(Error::PayloadTooLarge { .. })));
    }

    #[test]
    fn partial_frame_is_zero_padded() {
        // 250 samples = less than one 320-sample frame.
        let short = vec![1000i16; 250];
        let payload = encode(LibCodec2, &short, 1200, QR_CAPACITY_M).unwrap();
        let v = Payload::parse(&payload).unwrap().voice().unwrap().clone();
        assert_eq!(v.frame_count, 1);
        assert_eq!(decode(&LibCodec2, &payload).unwrap().len(), 320);
    }

    #[test]
    fn decode_skips_other_sections() {
        let pcm = sine_pcm(120);
        let payload = encode(LibCodec2, &pcm, 1200, QR_CAPACITY_M).unwrap();
        let mut p = Payload::parse(&payload).unwrap();
        p.sections.push(Section::Text("hello".to_string()));
        p.sections.push(Section::Image(ImageSection {
            codec: ImageCodec::WebP,
            data: vec![1, 2, 3],
        }));
        let mixed = p.build();
        let info = inspect(&LibCodec2, &mixed).unwrap();
        assert!(info.has_text && info.has_image);
        let back = decode(&LibCodec2, &mixed).unwrap();
        assert_eq!(back.len(), 960);
    }

    #[test]
    fn decode_without_voice_is_no_voice() {
        let p = Payload {
            version: crate::qv::QV_VERSION,
            sections: vec![Section::Text("only text".to_string())],
        };
        assert!(matches!(
            decode(&LibCodec2, &p.build()),
            Err(Error::NoVoiceSection)
        ));
    }

    #[test]
    fn max_duration_matches_capacity_math() {
        // (2331 - 10) / 6 = 386 frames * 40 ms = 15,440 ms.
        assert_eq!(max_duration_ms(&LibCodec2, 1200, QR_CAPACITY_M).unwrap(), 15_440);
    }
}
