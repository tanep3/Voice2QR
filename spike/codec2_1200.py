#!/usr/bin/env python3
"""Same sample at Codec2 1200: encode, decode, QR, verify round trip, side-by-side image."""
import ctypes, struct, sys, wave, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "pylib"))
import segno, zxingcpp
from PIL import Image, ImageDraw

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

MODE = 5  # verified earlier: spf=320, bpf=48 -> 1200 bps
st = lib.codec2_create(MODE)
SPF, BPF = lib.codec2_samples_per_frame(st), lib.codec2_bits_per_frame(st)
lib.codec2_destroy(st)
assert (SPF, BPF) == (320, 48), (SPF, BPF)
BPB = BPF // 8
print(f"1200 mode: {SPF} samples/frame, {BPF} bits/frame ({BPB} bytes)")

raw = open(os.path.join(BASE, "sample_8k.raw"), "rb").read()
samples = list(struct.unpack("<%dh" % (len(raw) // 2), raw))
nframes = (len(samples) + SPF - 1) // SPF
samples += [0] * (nframes * SPF - len(samples))

enc = lib.codec2_create(MODE)
bitstream = bytearray()
for i in range(nframes):
    frame = (ctypes.c_short * SPF)(*samples[i * SPF:(i + 1) * SPF])
    out = ctypes.create_string_buffer(BPB)
    lib.codec2_encode(enc, out, frame)
    bitstream += out.raw
lib.codec2_destroy(enc)
open(os.path.join(BASE, "voice_1200.c2"), "wb").write(bitstream)
print(f"frames={nframes} bitstream={len(bitstream)} bytes duration={nframes*SPF/8000:.2f}s")

dec = lib.codec2_create(MODE)
pcm = []
for i in range(nframes):
    out = (ctypes.c_short * SPF)()
    lib.codec2_decode(dec, out, bytes(bitstream[i * BPB:(i + 1) * BPB]))
    pcm.extend(out)
lib.codec2_destroy(dec)
with wave.open(os.path.join(BASE, "decoded_1200.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(struct.pack("<%dh" % len(pcm), *pcm))

payload = b"QV" + bytes([1]) + struct.pack("<HH", 1200, nframes) + bytes(bitstream)
qr = segno.make(payload, error="l", mode="byte", boost_error=False)
mods = 21 + 4 * (qr.version - 1)
print(f"payload={len(payload)} bytes -> QR Version {qr.version}, {mods} modules (+8 quiet zone = {mods+8})")
print(f"dots/module: T02 {384/(mods+8):.2f}, M02S53 {626/(mods+8):.2f}, M02S48 {567/(mods+8):.2f}")
png1200 = os.path.join(BASE, "voice_qr_1200.png")
qr.save(png1200, scale=8, border=4)

res = zxingcpp.read_barcode(Image.open(png1200))
got = bytes(res.bytes)
print("scan-back match:", got == payload)
assert got == payload
bps2, nf2 = struct.unpack("<HH", got[3:7])
print("scanned header:", bps2, "bps,", nf2, "frames")

# side-by-side: both QRs at the same module scale, labels below
q2400 = segno.make(open(os.path.join(BASE, "payload.bin"), "rb").read(), error="l", mode="byte", boost_error=False)
scale = 4
def render(q):
    m = 21 + 4 * (q.version - 1)
    img = Image.new("1", (m + 8, m + 8), 1)
    d = ImageDraw.Draw(img)
    for r, row in enumerate(q.matrix):
        for c, v in enumerate(row):
            if v:
                d.rectangle([c + 4, r + 4, c + 4, r + 4], fill=0)
    return img.resize(((m + 8) * scale, (m + 8) * scale), Image.NEAREST)
a, b = render(q2400), render(qr)
H = max(a.height, b.height)
label_h = 28
canvas = Image.new("RGB", (a.width + b.width + 30, H + label_h), "white")
canvas.paste(a, (0, 0)); canvas.paste(b, (a.width + 30, 0))
d = ImageDraw.Draw(canvas)
d.text((a.width // 2 - 60, H + 6), "2400 bps  (V38)", fill="black")
d.text((a.width + 30 + b.width // 2 - 60, H + 6), "1200 bps", fill="black")
canvas.save(os.path.join(BASE, "qr_compare.png"))
print("saved qr_compare.png", canvas.size, "| 1200 version:", qr.version, "| 2400 version:", q2400.version)
