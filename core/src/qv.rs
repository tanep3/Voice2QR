//! The QV format (v2) as pure structure: parse bytes into a [`Payload`],
//! build bytes back out. This layer knows nothing about Codec2 — in
//! particular it does not validate that a VOICE section's frame bytes
//! match its frame count; that is the codec layer's job (see
//! `docs/core-api.md` §3.1). Spec: `docs/format.md`.

use crate::{Error, Result};

/// The QV format version implemented here.
pub const QV_VERSION: u8 = 2;
/// Byte-mode capacity of a QR code at error-correction level M.
pub const QR_CAPACITY_M: usize = 2331;

pub const SECTION_VOICE: u8 = 0x01;
pub const SECTION_TEXT: u8 = 0x02;
pub const SECTION_IMAGE: u8 = 0x03;

const MAGIC: [u8; 2] = *b"QV";
/// magic (2) + version (1).
const HEADER_LEN: usize = 3;
/// type (1) + length (2).
const SECTION_HEADER_LEN: usize = 3;
/// bps (2) + frame count (2) inside a VOICE value.
const VOICE_SUBHEADER_LEN: usize = 4;

/// Image codecs carried by an IMAGE section.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageCodec {
    WebP = 1,
    Jpeg = 2,
}

impl ImageCodec {
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            1 => Some(ImageCodec::WebP),
            2 => Some(ImageCodec::Jpeg),
            _ => None,
        }
    }
    fn to_byte(self) -> u8 {
        self as u8
    }
}

/// A VOICE section: Codec2 frames plus the parameters needed to decode
/// them. `frames` is the raw frame byte string; its expected length is
/// `frame_count * bytes_per_frame(bps)`, which only the codec layer knows.
#[derive(Clone, PartialEq, Debug)]
pub struct VoiceSection {
    pub bps: u16,
    pub frame_count: u16,
    pub frames: Vec<u8>,
}

/// An IMAGE section: an encoded image (WebP or JPEG) as bytes.
#[derive(Clone, PartialEq, Debug)]
pub struct ImageSection {
    pub codec: ImageCodec,
    pub data: Vec<u8>,
}

/// One section of a QV payload. Unknown section kinds are preserved
/// verbatim so a parse/build round trip loses nothing.
#[derive(Clone, PartialEq, Debug)]
pub enum Section {
    Voice(VoiceSection),
    Text(String),
    Image(ImageSection),
    Unknown { kind: u8, data: Vec<u8> },
}

impl Section {
    fn kind(&self) -> u8 {
        match self {
            Section::Voice(_) => SECTION_VOICE,
            Section::Text(_) => SECTION_TEXT,
            Section::Image(_) => SECTION_IMAGE,
            Section::Unknown { kind, .. } => *kind,
        }
    }

    fn write_value(&self, out: &mut Vec<u8>) {
        match self {
            Section::Voice(v) => {
                out.extend_from_slice(&v.bps.to_le_bytes());
                out.extend_from_slice(&v.frame_count.to_le_bytes());
                out.extend_from_slice(&v.frames);
            }
            Section::Text(t) => out.extend_from_slice(t.as_bytes()),
            Section::Image(img) => {
                out.push(img.codec.to_byte());
                out.extend_from_slice(&img.data);
            }
            Section::Unknown { data, .. } => out.extend_from_slice(data),
        }
    }

    fn value_len(&self) -> usize {
        match self {
            Section::Voice(v) => VOICE_SUBHEADER_LEN + v.frames.len(),
            Section::Text(t) => t.len(),
            Section::Image(img) => 1 + img.data.len(),
            Section::Unknown { data, .. } => data.len(),
        }
    }
}

/// A parsed QV payload.
#[derive(Clone, PartialEq, Debug)]
pub struct Payload {
    pub version: u8,
    pub sections: Vec<Section>,
}

impl Payload {
    /// A payload holding a single VOICE section (what Voice2QR writes).
    pub fn new_voice(voice: VoiceSection) -> Self {
        Payload { version: QV_VERSION, sections: vec![Section::Voice(voice)] }
    }

    /// Parse a payload from raw bytes.
    ///
    /// Fails with [`Error::NotQv`] if the magic is absent,
    /// [`Error::UnsupportedVersion`] for a version other than
    /// [`QV_VERSION`], and [`Error::Malformed`] for structural damage
    /// (truncated header, section length overrunning the payload,
    /// a VOICE value shorter than its subheader, invalid UTF-8 TEXT,
    /// an empty IMAGE value).
    pub fn parse(bytes: &[u8]) -> Result<Payload> {
        if bytes.len() < MAGIC.len() || bytes[0] != MAGIC[0] || bytes[1] != MAGIC[1] {
            return Err(Error::NotQv);
        }
        if bytes.len() < HEADER_LEN {
            return Err(Error::Malformed("header truncated"));
        }
        let version = bytes[2];
        if version != QV_VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        let mut sections = Vec::new();
        let mut off = HEADER_LEN;
        while off < bytes.len() {
            if off + SECTION_HEADER_LEN > bytes.len() {
                return Err(Error::Malformed("section header truncated"));
            }
            let kind = bytes[off];
            let len = u16::from_le_bytes([bytes[off + 1], bytes[off + 2]]) as usize;
            let start = off + SECTION_HEADER_LEN;
            if start + len > bytes.len() {
                return Err(Error::Malformed("section length overruns payload"));
            }
            let value = &bytes[start..start + len];
            let section = match kind {
                SECTION_VOICE => {
                    if value.len() < VOICE_SUBHEADER_LEN {
                        return Err(Error::Malformed("voice value too short"));
                    }
                    Section::Voice(VoiceSection {
                        bps: u16::from_le_bytes([value[0], value[1]]),
                        frame_count: u16::from_le_bytes([value[2], value[3]]),
                        frames: value[VOICE_SUBHEADER_LEN..].to_vec(),
                    })
                }
                SECTION_TEXT => Section::Text(
                    String::from_utf8(value.to_vec())
                        .map_err(|_| Error::Malformed("text is not valid UTF-8"))?,
                ),
                SECTION_IMAGE => {
                    if value.is_empty() {
                        return Err(Error::Malformed("image value empty"));
                    }
                    match ImageCodec::from_byte(value[0]) {
                        Some(codec) => Section::Image(ImageSection {
                            codec,
                            data: value[1..].to_vec(),
                        }),
                        // An image codec this reader does not know: keep the
                        // section verbatim instead of failing the payload.
                        None => Section::Unknown { kind, data: value.to_vec() },
                    }
                }
                _ => Section::Unknown { kind, data: value.to_vec() },
            };
            sections.push(section);
            off = start + len;
        }
        Ok(Payload { version, sections })
    }

    /// Serialize back to bytes. Sections are written in the order held;
    /// writers add them in ascending type order for deterministic output.
    pub fn build(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            HEADER_LEN
                + self
                    .sections
                    .iter()
                    .map(|s| SECTION_HEADER_LEN + s.value_len())
                    .sum::<usize>(),
        );
        out.extend_from_slice(&MAGIC);
        out.push(self.version);
        for s in &self.sections {
            out.push(s.kind());
            let len = s.value_len();
            debug_assert!(len <= u16::MAX as usize, "section too large to build");
            out.extend_from_slice(&(len as u16).to_le_bytes());
            s.write_value(&mut out);
        }
        out
    }

    /// The first VOICE section, if any (spec: first one wins).
    pub fn voice(&self) -> Option<&VoiceSection> {
        self.sections.iter().find_map(|s| match s {
            Section::Voice(v) => Some(v),
            _ => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> Payload {
        Payload {
            version: QV_VERSION,
            sections: vec![
                Section::Voice(VoiceSection {
                    bps: 1200,
                    frame_count: 3,
                    frames: vec![0xAA; 18],
                }),
                Section::Text("こんにちは".to_string()),
                Section::Image(ImageSection {
                    codec: ImageCodec::WebP,
                    data: vec![1, 2, 3, 4],
                }),
                Section::Unknown { kind: 0x7F, data: vec![9, 9] },
            ],
        }
    }

    #[test]
    fn round_trip_preserves_everything() {
        let p = sample_payload();
        let bytes = p.build();
        let back = Payload::parse(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn voice_only_layout_matches_spec() {
        // header(3) + section header(3) + bps(2) + frames-count(2) + 6 bytes
        let p = Payload::new_voice(VoiceSection {
            bps: 1200,
            frame_count: 1,
            frames: vec![0; 6],
        });
        let b = p.build();
        assert_eq!(b.len(), 16);
        assert_eq!(&b[0..2], b"QV");
        assert_eq!(b[2], 2);
        assert_eq!(b[3], SECTION_VOICE);
        assert_eq!(u16::from_le_bytes([b[4], b[5]]), 10);
        assert_eq!(u16::from_le_bytes([b[6], b[7]]), 1200);
        assert_eq!(u16::from_le_bytes([b[8], b[9]]), 1);
    }

    #[test]
    fn bad_magic_is_not_qv() {
        assert!(matches!(Payload::parse(b"XX\x02"), Err(Error::NotQv)));
        assert!(matches!(Payload::parse(b""), Err(Error::NotQv)));
        assert!(matches!(Payload::parse(b"Q"), Err(Error::NotQv)));
    }

    #[test]
    fn version_one_is_unsupported_not_malformed() {
        let mut b = sample_payload().build();
        b[2] = 1;
        assert!(matches!(
            Payload::parse(&b),
            Err(Error::UnsupportedVersion(1))
        ));
    }

    #[test]
    fn truncated_section_is_malformed() {
        let mut b = sample_payload().build();
        b.truncate(b.len() - 1);
        assert!(matches!(Payload::parse(&b), Err(Error::Malformed(_))));
    }

    #[test]
    fn short_voice_value_is_malformed() {
        let b = [b'Q', b'V', 2, SECTION_VOICE, 3, 0, 1, 2, 3];
        assert!(matches!(Payload::parse(&b), Err(Error::Malformed(_))));
    }

    #[test]
    fn first_voice_wins() {
        let p = Payload {
            version: QV_VERSION,
            sections: vec![
                Section::Voice(VoiceSection { bps: 1200, frame_count: 1, frames: vec![0; 6] }),
                Section::Voice(VoiceSection { bps: 2400, frame_count: 2, frames: vec![0; 16] }),
            ],
        };
        let back = Payload::parse(&p.build()).unwrap();
        assert_eq!(back.voice().unwrap().bps, 1200);
    }

    #[test]
    fn unknown_image_codec_is_preserved_verbatim() {
        // IMAGE section with a future codec byte (9): must not fail parsing
        // and must round-trip byte-identically (as an Unknown section).
        let b = [b'Q', b'V', 2, SECTION_IMAGE, 3, 0, 9, 0x10, 0x20];
        let p = Payload::parse(&b).unwrap();
        assert!(matches!(p.sections[0], Section::Unknown { kind: SECTION_IMAGE, .. }));
        assert_eq!(p.build(), b);
    }

    #[test]
    fn header_only_payload_is_valid_and_voiceless() {
        let p = Payload::parse(&[b'Q', b'V', 2]).unwrap();
        assert!(p.voice().is_none());
        assert!(p.sections.is_empty());
    }
}
