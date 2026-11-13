#!/usr/bin/env python3
"""Codec2 2400 encode/decode via libcodec2 ctypes, then pack into QR and verify round trip."""
import ctypes, struct, sys, wave, os

BASE = os.path.dirname(os.path.abspath(__file__))
lib = ctypes.CDLL("/usr/lib/x86_64-linux-gnu/libcodec2.so.1.2")
lib.codec2_create.restype = ctypes.c_void_p
lib.codec2_create.argtypes = [ctypes.c_int]
lib.codec2_samples_per_frame.restype = ctypes.c_int
lib.codec2_samples_per_frame.argtypes = [ctypes.c_void_p]
lib.codec2_bits_per_frame.restype = ctypes.c_int
lib.codec2_bits_per_frame.argtypes = [ctypes.c_void_p]
lib.codec2_encode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_short)]
lib.codec2_decode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_short), ctypes.c_char_p]

# Find the mode whose shape is 2400bps: 160 samples/frame (20ms), 48 bits/frame (6 bytes)
MODE = None
for m in range(9):
    st = lib.codec2_create(m)
    if not st:
        continue
    spf, bpf = lib.codec2_samples_per_frame(st), lib.codec2_bits_per_frame(st)
    print(f"mode {m}: samples/frame={spf} bits/frame={bpf} -> {(bpf*8000/spf):.0f} bps")
    if spf == 160 and bpf == 48:
        MODE = m
    lib.codec2_destroy(st)
assert MODE is not None, "2400 mode not found"
print("using mode index", MODE)

raw = open(os.path.join(BASE, "sample_8k.raw"), "rb").read()
samples = struct.unpack("<%dh" % (len(raw) // 2), raw)
spf, bpf_bytes = 160, 6
nframes = (len(samples) + spf - 1) // spf
samples = list(samples) + [0] * (nframes * spf - len(samples))

enc = lib.codec2_create(MODE)
bitstream = bytearray()
for i in range(nframes):
    frame = (ctypes.c_short * spf)(*samples[i * spf:(i + 1) * spf])
    out = ctypes.create_string_buffer(bpf_bytes)
    lib.codec2_encode(enc, out, frame)
    bitstream += out.raw
lib.codec2_destroy(enc)
open(os.path.join(BASE, "voice_2400.c2"), "wb").write(bitstream)
print(f"frames={nframes} bitstream={len(bitstream)} bytes duration={nframes*spf/8000:.2f}s")

dec = lib.codec2_create(MODE)
pcm_out = []
for i in range(nframes):
    frame_bits = bytes(bitstream[i * bpf_bytes:(i + 1) * bpf_bytes])
    out = (ctypes.c_short * spf)()
    lib.codec2_decode(dec, out, frame_bits)
    pcm_out.extend(out)
lib.codec2_destroy(dec)

def write_wav(path, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(struct.pack("<%dh" % len(pcm), *pcm))

write_wav(os.path.join(BASE, "decoded_2400.wav"), pcm_out)
write_wav(os.path.join(BASE, "original_8k.wav"), samples[:69035])
print("decoded wav written, samples:", len(pcm_out))

# ---- QR payload: header 'QV' + ver(1) + mode_bps uint16 + frames uint16 + bitstream
payload = b"QV" + bytes([1]) + struct.pack("<HH", 2400, nframes) + bytes(bitstream)
open(os.path.join(BASE, "payload.bin"), "wb").write(payload)
print("payload bytes:", len(payload))
