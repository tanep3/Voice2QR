# Codec2 builds

Codec2 is pinned to **version 1.2.0** and built from source for every
target (see `docs/system-design.md` §6). The tarball is verified
against a recorded SHA-256 before use. Do not build it with
`-ffast-math` or similar floating-point optimizations — they change
the encoder's output (measured 2026-11-14).

- `build-wasm.sh` — builds `out/codec2.wasm`, a standalone WebAssembly
  module exporting the codec2 C API, for the web face. Codec2 is
  LGPL-2.1 and is used unmodified; the wasm module is a separate file
  from the core wasm (see `third_party/codec2/` for the license).

The native library used by the Rust core's tests is built by CI
(`.github/workflows/ci.yml`) the same way: pinned tarball, verified
hash, plain Release build.
