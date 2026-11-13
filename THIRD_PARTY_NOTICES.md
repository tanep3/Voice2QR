# Third-Party Notices

Voice2QR itself is released under the MIT License (see `LICENSE`).
The following third-party components are used under their own licenses.
They are **not** covered by the MIT License above.

## Codec2 — LGPL-2.1

- Component: Codec2 low-bit-rate speech codec (library `libcodec2`)
- Copyright: © David Rowe and contributors
- License: GNU Lesser General Public License, version 2.1 (`LGPL-2.1`)
- Full license text: `third_party/codec2/COPYING`
- Source: https://github.com/drowe67/codec2 (reference version used in the
  verification spike: 1.2.0)
- How Voice2QR uses it: **unmodified**, as a separate library (dynamically
  linked / separate shared object). Voice2QR does not incorporate Codec2 source
  code into its own MIT-licensed code. If you modify Codec2 itself, your
  modifications to that component must be made available under the LGPL-2.1.

## segno — BSD-3-Clause

- Component: segno QR code generator (used by the Python spike in `spike/`)
- License: BSD 3-Clause License
- Source: https://github.com/heuer/segno

## ZXing-C++ — Apache-2.0

- Component: zxing-cpp QR code reader (used by the Python spike in `spike/`
  for scan-back verification)
- License: Apache License, Version 2.0
- Source: https://github.com/zxing-cpp/zxing-cpp
