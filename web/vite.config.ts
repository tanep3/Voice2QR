import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// The deployed app's version (package.json "appVersion", bumped per
// release). Injected into the bundle so the running app can compare
// itself against the site's version.json and force a refresh when a
// new release has been deployed under it (see app/main.ts).
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
  appVersion?: string;
};

// The app is a static site. `base: './'` keeps every asset reference
// relative, so the same build works on GitHub Pages, on a home server,
// or from any subpath (self-contained deployments — docs/system-design.md).
// The JS library is NOT bundled into the app: scripts/assemble-site.mjs
// copies the built library to site/lib/v1/ and the app imports it at
// runtime from that co-located path.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.appVersion ?? '0.0.0'),
  },
  build: {
    outDir: 'site',
    emptyOutDir: true,
  },
  plugins: [serveLibraryInDev()],
});

// In `vite dev`, serve the library build (web/dist/) at /lib/v1/ so the
// app's runtime import path is identical to production.
function serveLibraryInDev(): Plugin {
  const dist = join(__dirname, 'dist');
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.ts': 'text/typescript',
  };
  return {
    name: 'serve-lib-v1',
    configureServer(server) {
      server.middlewares.use('/lib/v1', (req, res, next) => {
        const path = join(dist, (req.url ?? '/').split('?')[0]);
        if (!path.startsWith(dist) || !existsSync(path) || !statSync(path).isFile()) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          types[extname(path)] ?? 'application/octet-stream',
        );
        createReadStream(path).pipe(res);
      });
    },
  };
}
