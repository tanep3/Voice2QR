// Assemble the deployable site: vite build output + the published
// library at lib/v1/ (the app imports it from there at runtime).
//
//   npm run build        -> web/dist/   (library)
//   npm run build:app    -> web/site/   (this script runs after vite)
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, 'dist');
const siteLib = join(web, 'site', 'lib', 'v1');

if (!existsSync(dist)) {
  console.error('web/dist is missing — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(join(web, 'site'))) {
  console.error('web/site is missing — vite build must run first.');
  process.exit(1);
}
rmSync(siteLib, { recursive: true, force: true });
cpSync(dist, siteLib, { recursive: true });
console.log('assembled: site/lib/v1/ <- dist/');

// Stamp the app version into the service worker (its cache name) and
// publish version.json, so a deployed update is detectable by both the
// browser's service-worker update check and the app's startup probe.
const pkg = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
const appVersion = pkg.appVersion ?? '0.0.0';
const swPath = join(web, 'site', 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__APP_VERSION__')) {
  console.error('site/sw.js has no __APP_VERSION__ placeholder to stamp.');
  process.exit(1);
}
writeFileSync(swPath, sw.replaceAll('__APP_VERSION__', appVersion));
writeFileSync(join(web, 'site', 'version.json'), JSON.stringify({ version: appVersion }) + '\n');
console.log('stamped: site/sw.js + version.json @ ' + appVersion);
