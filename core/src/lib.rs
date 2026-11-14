//! Voice2QR shared core.
//!
//! Layers (see `docs/core-api.md`):
//! - [`qv`]: the QV format as pure structure (parse / build). No codec knowledge.
//! - [`codec`]: the codec abstraction (trait) and the libcodec2 FFI backend.
//! - [`engine`]: inspect / encode / decode, tying `qv` and `codec` together.
//! - [`ffi`]: the C ABI projection of the engine (WASM and JNI face onto this).

pub mod codec;
pub mod engine;
pub mod ffi;
pub mod qv;

/// Errors returned by the core. The C ABI maps these 1:1 onto `QvStatus`.
#[derive(Debug)]
pub enum Error {
    /// The payload does not start with the "QV" magic.
    NotQv,
    /// The payload's format version is not supported by this core.
    UnsupportedVersion(u8),
    /// The payload structure is broken (section length overrun, short
    /// VOICE value, inconsistent frame data, invalid UTF-8 in TEXT, ...).
    Malformed(&'static str),
    /// The payload has no VOICE section.
    NoVoiceSection,
    /// The codec has no mode for this bit rate.
    UnsupportedBps(u16),
    /// The finished payload would exceed the given capacity.
    PayloadTooLarge { len: usize, capacity: usize },
    /// The codec backend failed.
    Codec(&'static str),
    /// An argument was invalid (empty input, null pointer at the FFI seam, ...).
    InvalidArgument(&'static str),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotQv => write!(f, "not a QV payload"),
            Error::UnsupportedVersion(v) => write!(f, "unsupported QV version: {v}"),
            Error::Malformed(why) => write!(f, "malformed QV payload: {why}"),
            Error::NoVoiceSection => write!(f, "no VOICE section"),
            Error::UnsupportedBps(bps) => write!(f, "unsupported Codec2 bit rate: {bps}"),
            Error::PayloadTooLarge { len, capacity } => {
                write!(f, "payload of {len} bytes exceeds capacity {capacity}")
            }
            Error::Codec(why) => write!(f, "codec failure: {why}"),
            Error::InvalidArgument(why) => write!(f, "invalid argument: {why}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
