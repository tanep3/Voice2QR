// Assemble the deployable site: vite build output + the published
// library at lib/v1/ (the app imports it from there at runtime).
//
//   npm run build        -> web/dist/   (library)
//   npm run build:app    -> web/site/   (this script runs after vite)
import { cpSync, existsSync, rmSync } from 'node:fs';
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
