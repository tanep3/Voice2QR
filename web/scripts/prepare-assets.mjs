// Copy the two wasm modules next to the built library, under their
// published names, so the library's default URL resolution (relative
// to the module's own URL) works in tests and in the published layout
// alike:
//
//   dist/index.js  +  dist/voice2qr_core.wasm  +  dist/codec2.wasm
//
// Build the inputs first:
//   cargo build --manifest-path core/Cargo.toml \
//       --target wasm32-unknown-unknown --release
//   codec2/build-wasm.sh
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const assets = [
  ['core/target/wasm32-unknown-unknown/release/voice2qr_core.wasm',
   'dist/voice2qr_core.wasm'],
  ['codec2/out/codec2.wasm', 'dist/codec2.wasm'],
  // The QR reader's wasm ships with the library (never a CDN).
  ['web/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',
   'dist/zxing_reader.wasm'],
];
for (const [src, dst] of assets) {
  const from = join(repo, src);
  if (!existsSync(from)) {
    console.error(`missing wasm input: ${src} (build it first — see above)`);
    process.exit(1);
  }
  copyFileSync(from, join(web, dst));
  console.log(`asset: ${dst}`);
}
