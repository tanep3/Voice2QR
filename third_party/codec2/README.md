# Codec2 (third-party component)

Codec2 is **not** part of Voice2QR's MIT-licensed code. It is an independent
component used under the GNU Lesser General Public License v2.1.

- Upstream: https://github.com/drowe67/codec2
- Version used in the verification spike: 1.2.0 (system `libcodec2.so.1.2`)
- License text: `COPYING` in this directory
- Usage policy in this project: **unmodified, dynamically linked** (system
  library on PC; a separate `libcodec2.so` inside the Android app). No
  Codec2 source files are vendored into this repository at this time; build
  instructions will fetch or reference the upstream library.
