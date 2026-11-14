//! The C ABI: a 1:1 projection of the engine over [`LibCodec2`].
//! Contract and ownership rules: `docs/core-api.md` §4 and
//! `core/include/qv.h`.
//!
//! Ownership recap: inputs are borrowed for the call only; a successful
//! call that fills a [`QvBytes`] transfers ownership to the caller, who
//! must release it exactly once with [`qv_bytes_free`]; a `QvEncoder`
//! handle is released by exactly one of [`qv_encoder_finalize`] or
//! [`qv_encoder_free`].

use crate::codec::LibCodec2;
use crate::engine::{self, Encoder};
use crate::Error;
use std::os::raw::c_int;

pub const QV_OK: c_int = 0;
pub const QV_ERR_NOT_QV: c_int = 1;
pub const QV_ERR_UNSUPPORTED_VERSION: c_int = 2;
pub const QV_ERR_MALFORMED: c_int = 3;
pub const QV_ERR_NO_VOICE: c_int = 4;
pub const QV_ERR_UNSUPPORTED_BPS: c_int = 5;
pub const QV_ERR_TOO_LARGE: c_int = 6;
pub const QV_ERR_CODEC: c_int = 7;
pub const QV_ERR_INVALID_ARGUMENT: c_int = 8;

fn status_of(e: &Error) -> c_int {
    match e {
        Error::NotQv => QV_ERR_NOT_QV,
        Error::UnsupportedVersion(_) => QV_ERR_UNSUPPORTED_VERSION,
        Error::Malformed(_) => QV_ERR_MALFORMED,
        Error::NoVoiceSection => QV_ERR_NO_VOICE,
        Error::UnsupportedBps(_) => QV_ERR_UNSUPPORTED_BPS,
        Error::PayloadTooLarge { .. } => QV_ERR_TOO_LARGE,
        Error::Codec(_) => QV_ERR_CODEC,
        Error::InvalidArgument(_) => QV_ERR_INVALID_ARGUMENT,
    }
}

/// A byte buffer owned by the caller after a successful call.
#[repr(C)]
pub struct QvBytes {
    pub data: *mut u8,
    pub len: usize,
}

/// Payload summary written by [`qv_inspect`].
#[repr(C)]
pub struct QvInfo {
    pub version: u8,
    pub has_voice: c_int,
    pub bps: u16,
    pub frame_count: u32,
    pub duration_ms: u32,
    pub has_text: c_int,
    pub has_image: c_int,
}

fn bytes_out(out: *mut QvBytes, mut v: Vec<u8>) -> c_int {
    let data = v.as_mut_ptr();
    let len = v.len();
    std::mem::forget(v);
    unsafe {
        (*out).data = data;
        (*out).len = len;
    }
    QV_OK
}

fn slice_of<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if ptr.is_null() {
        if len == 0 {
            Some(&[])
        } else {
            None
        }
    } else {
        Some(unsafe { std::slice::from_raw_parts(ptr, len) })
    }
}

fn pcm_of<'a>(ptr: *const i16, samples: usize) -> Option<&'a [i16]> {
    if ptr.is_null() {
        if samples == 0 {
            Some(&[])
        } else {
            None
        }
    } else {
        Some(unsafe { std::slice::from_raw_parts(ptr, samples) })
    }
}

#[no_mangle]
pub extern "C" fn qv_inspect(payload: *const u8, len: usize, out: *mut QvInfo) -> c_int {
    if out.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    let Some(bytes) = slice_of(payload, len) else {
        return QV_ERR_INVALID_ARGUMENT;
    };
    match engine::inspect(&LibCodec2, bytes) {
        Ok(info) => {
            let (has_voice, bps, frame_count, duration_ms) = match &info.voice {
                Some(v) => (1, v.bps, v.frame_count as u32, v.duration_ms),
                None => (0, 0, 0, 0),
            };
            unsafe {
                (*out).version = info.version;
                (*out).has_voice = has_voice;
                (*out).bps = bps;
                (*out).frame_count = frame_count;
                (*out).duration_ms = duration_ms;
                (*out).has_text = info.has_text as c_int;
                (*out).has_image = info.has_image as c_int;
            }
            QV_OK
        }
        Err(e) => status_of(&e),
    }
}

#[no_mangle]
pub extern "C" fn qv_decode(payload: *const u8, len: usize, out_pcm: *mut QvBytes) -> c_int {
    if out_pcm.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    let Some(bytes) = slice_of(payload, len) else {
        return QV_ERR_INVALID_ARGUMENT;
    };
    match engine::decode(&LibCodec2, bytes) {
        Ok(pcm) => {
            let mut v = Vec::with_capacity(pcm.len() * 2);
            for s in pcm {
                v.extend_from_slice(&s.to_le_bytes());
            }
            bytes_out(out_pcm, v)
        }
        Err(e) => status_of(&e),
    }
}

#[no_mangle]
pub extern "C" fn qv_encode(
    pcm: *const i16,
    samples: usize,
    bps: u16,
    capacity: usize,
    out_payload: *mut QvBytes,
) -> c_int {
    if out_payload.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    let Some(pcm) = pcm_of(pcm, samples) else {
        return QV_ERR_INVALID_ARGUMENT;
    };
    match engine::encode(LibCodec2, pcm, bps, capacity) {
        Ok(payload) => bytes_out(out_payload, payload),
        Err(e) => status_of(&e),
    }
}

/// Opaque encoder handle.
pub struct QvEncoder {
    inner: Encoder<LibCodec2>,
}

#[no_mangle]
pub extern "C" fn qv_encoder_new(bps: u16, capacity: usize, out: *mut *mut QvEncoder) -> c_int {
    if out.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    match Encoder::new(LibCodec2, bps, capacity) {
        Ok(enc) => {
            unsafe { *out = Box::into_raw(Box::new(QvEncoder { inner: enc })) };
            QV_OK
        }
        Err(e) => status_of(&e),
    }
}

#[no_mangle]
pub extern "C" fn qv_encoder_push(
    enc: *mut QvEncoder,
    pcm: *const i16,
    samples: usize,
) -> c_int {
    if enc.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    let Some(pcm) = pcm_of(pcm, samples) else {
        return QV_ERR_INVALID_ARGUMENT;
    };
    let enc = unsafe { &mut (*enc).inner };
    match enc.push_pcm(pcm) {
        Ok(()) => QV_OK,
        Err(e) => status_of(&e),
    }
}

#[no_mangle]
pub extern "C" fn qv_encoder_stats(
    enc: *const QvEncoder,
    frames: *mut u32,
    payload_len: *mut usize,
) -> c_int {
    if enc.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    let enc = unsafe { &(*enc).inner };
    unsafe {
        if !frames.is_null() {
            *frames = enc.frames_encoded();
        }
        if !payload_len.is_null() {
            *payload_len = enc.payload_len();
        }
    }
    QV_OK
}

#[no_mangle]
pub extern "C" fn qv_encoder_finalize(enc: *mut QvEncoder, out_payload: *mut QvBytes) -> c_int {
    if enc.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    // The handle is consumed either way.
    let boxed = unsafe { Box::from_raw(enc) };
    if out_payload.is_null() {
        return QV_ERR_INVALID_ARGUMENT;
    }
    match boxed.inner.finish() {
        Ok(payload) => bytes_out(out_payload, payload),
        Err(e) => status_of(&e),
    }
}

#[no_mangle]
pub extern "C" fn qv_encoder_free(enc: *mut QvEncoder) {
    if !enc.is_null() {
        drop(unsafe { Box::from_raw(enc) });
    }
}

#[no_mangle]
pub extern "C" fn qv_bytes_free(b: *mut QvBytes) {
    if b.is_null() {
        return;
    }
    unsafe {
        let data = (*b).data;
        let len = (*b).len;
        if !data.is_null() && len > 0 {
            drop(Vec::from_raw_parts(data, len, len));
        }
        (*b).data = std::ptr::null_mut();
        (*b).len = 0;
    }
}

#[no_mangle]
pub extern "C" fn qv_max_duration_ms(bps: u16, capacity: usize) -> u32 {
    engine::max_duration_ms(&LibCodec2, bps, capacity).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qv::QR_CAPACITY_M;

    #[test]
    fn ffi_encode_inspect_decode() {
        let pcm: Vec<i16> = (0..1600).map(|i| ((i % 100) as i16 - 50) * 100).collect();
        let mut out = QvBytes { data: std::ptr::null_mut(), len: 0 };
        let st = qv_encode(
            pcm.as_ptr(),
            pcm.len(),
            1200,
            QR_CAPACITY_M,
            &mut out,
        );
        assert_eq!(st, QV_OK);
        assert!(out.len > 10);

        let mut info = QvInfo {
            version: 0,
            has_voice: 0,
            bps: 0,
            frame_count: 0,
            duration_ms: 0,
            has_text: 0,
            has_image: 0,
        };
        let st = qv_inspect(out.data, out.len, &mut info);
        assert_eq!(st, QV_OK);
        assert_eq!(info.has_voice, 1);
        assert_eq!(info.bps, 1200);
        assert_eq!(info.frame_count, 5);
        assert_eq!(info.duration_ms, 200);

        let mut back = QvBytes { data: std::ptr::null_mut(), len: 0 };
        let st = qv_decode(out.data, out.len, &mut back);
        assert_eq!(st, QV_OK);
        assert_eq!(back.len, pcm.len() * 2);

        qv_bytes_free(&mut out);
        qv_bytes_free(&mut back);
        assert!(out.data.is_null() && back.data.is_null());
    }

    #[test]
    fn ffi_errors_map() {
        let mut info = QvInfo {
            version: 0,
            has_voice: 0,
            bps: 0,
            frame_count: 0,
            duration_ms: 0,
            has_text: 0,
            has_image: 0,
        };
        let junk = b"not a qv payload";
        assert_eq!(qv_inspect(junk.as_ptr(), junk.len(), &mut info), QV_ERR_NOT_QV);
        assert_eq!(qv_inspect(std::ptr::null(), 3, &mut info), QV_ERR_INVALID_ARGUMENT);
        assert_eq!(qv_max_duration_ms(1200, QR_CAPACITY_M), 15_440);
        assert_eq!(qv_max_duration_ms(999, QR_CAPACITY_M), 0);
    }

    #[test]
    fn ffi_streaming_encoder() {
        let mut enc: *mut QvEncoder = std::ptr::null_mut();
        assert_eq!(qv_encoder_new(1200, QR_CAPACITY_M, &mut enc), QV_OK);
        let chunk = vec![500i16; 320];
        assert_eq!(qv_encoder_push(enc, chunk.as_ptr(), chunk.len()), QV_OK);
        let mut frames = 0u32;
        let mut plen = 0usize;
        assert_eq!(qv_encoder_stats(enc, &mut frames, &mut plen), QV_OK);
        assert_eq!(frames, 1);
        assert_eq!(plen, 16);
        let mut out = QvBytes { data: std::ptr::null_mut(), len: 0 };
        assert_eq!(qv_encoder_finalize(enc, &mut out), QV_OK);
        assert_eq!(out.len, 16);
        qv_bytes_free(&mut out);
    }
}
