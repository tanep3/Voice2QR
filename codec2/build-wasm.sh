#!/bin/sh
# Build codec2.wasm: Codec2 1.2.0 (pinned) compiled to a standalone
# WebAssembly module for the Voice2QR web face.
#
# The module exports the raw codec2 C API plus malloc/free and its
# memory. The JS library instantiates it first and hands its functions
# to the core wasm as imports (JS-mediated linking — see
# docs/system-design.md), wrapping encode/decode with buffer copies
# between the two memories. Codec2 stays a separate, unmodified
# artifact (LGPL-2.1 separation at the file level).
#
# Usage:  codec2/build-wasm.sh
# Needs:  emcc (Emscripten), curl, sha256sum, cmake
# Output: codec2/out/codec2.wasm
set -e
cd "$(dirname "$0")"

VERSION=1.2.0
SHA256=cbccae52b2c2ecc5d2757e407da567eb681241ff8dadce39d779a7219dbcf449
TARBALL=codec2-$VERSION.tar.gz
SRC=src-$VERSION

if [ ! -d "$SRC" ]; then
    echo "fetching Codec2 $VERSION"
    curl -sL -o "$TARBALL" \
        "https://github.com/drowe67/codec2/archive/refs/tags/$VERSION.tar.gz"
    echo "$SHA256  $TARBALL" | sha256sum -c -
    tar xzf "$TARBALL"
    mv "codec2-$VERSION" "$SRC"
fi

# Build the codec2 library (only the library target, static) with
# Emscripten.
emcmake cmake -B "$SRC/build-wasm" -S "$SRC" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF
cmake --build "$SRC/build-wasm" --target codec2 -j

mkdir -p out
# Link a standalone module: no entry point, no JS runtime — just the
# codec functions, malloc/free, and the module's memory as exports.
emcc --no-entry -O3 \
    -s STANDALONE_WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_codec2_create","_codec2_destroy","_codec2_encode","_codec2_decode","_codec2_samples_per_frame","_codec2_bits_per_frame","_malloc","_free"]' \
    "$SRC/build-wasm/src/libcodec2.a" \
    -o out/codec2.wasm

echo "built: codec2/out/codec2.wasm"
