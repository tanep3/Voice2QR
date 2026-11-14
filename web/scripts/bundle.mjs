// Bundle the library entries with esbuild.
//
// Why: the published library is loaded by browsers as plain ES modules
// from lib/v1/ — a bare specifier like 'zxing-wasm/reader' cannot
// resolve there (Node resolves it, which hid the problem in tests).
// Bundling inlines the QR reader (and the vendored qrcodegen) so the
// shipped files reference only relative paths and the co-located wasm
// files. Type declarations still come from tsc (see package.json).
//
// 'node:*' stays external: bridge.ts dynamically imports node builtins
// on its file:-URL path, which only ever executes under Node.
import { build } from 'esbuild';

await build({
  entryPoints: ['lib/index.ts', 'lib/browser.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['node:*'],
  outdir: 'dist',
  logLevel: 'info',
});
