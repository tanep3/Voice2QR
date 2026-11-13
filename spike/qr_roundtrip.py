#!/usr/bin/env python3
"""Make QR from payload.bin, scan it back with zxing-cpp, re-decode speech, compare."""
import sys, os, struct, ctypes
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "pylib"))
import segno, zxingcpp
from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
payload = open(os.path.join(BASE, "payload.bin"), "rb").read()

qr = segno.make(payload, error="l", mode="byte", boost_error=False)
print("QR version:", qr.version, "modules:", qr.symbol_size())
png = os.path.join(BASE, "voice_qr.png")
qr.save(png, scale=8, border=4)
print("saved", png, os.path.getsize(png), "bytes")

res = zxingcpp.read_barcode(Image.open(png))
assert res is not None, "scan failed"
got = res.bytes if isinstance(res.bytes, (bytes, bytearray)) else res.text.encode("latin-1")
print("scanned bytes:", len(got), "match:", bytes(got) == payload)
assert bytes(got) == payload

# Re-decode straight from the scanned bytes
assert got[:2] == b"QV"
bps, nframes = struct.unpack("<HH", got[3:7])
print("header: bps", bps, "frames", nframes)
bitstream = bytes(got[7:])
lib = ctypes.CDLL("/usr/lib/x86_64-linux-gnu/libcodec2.so.1.2")
lib.codec2_create.restype = ctypes.c_void_p
dec = lib.codec2_create(1)  # 2400
pcm = []
for i in range(nframes):
    out = (ctypes.c_short * 160)()
    lib.codec2_decode(dec, out, bitstream[i * 6:(i + 1) * 6])
    pcm.extend(out)
lib.codec2_destroy(dec)
import wave
ref = wave.open(os.path.join(BASE, "decoded_2400.wav"))
ref_pcm = struct.unpack("<%dh" % (ref.getnframes()), ref.readframes(ref.getnframes()))
print("round-trip PCM identical to direct decode:", tuple(pcm) == tuple(ref_pcm))
