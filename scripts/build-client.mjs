/*
 * Bundle the browser app.
 *
 * app.ts imports `marked`, `dompurify` and the shared `src/markdown.ts` (which pulls in
 * `turndown`), so `tsc` can no longer emit a runnable `public/app.js` on its own — the
 * imports would remain unresolved at runtime. esbuild bundles them into the single
 * classic script the shell already loads (`<script src="/app.js" defer>`), so no module
 * loader or import map is needed. `tsconfig.client.json` still runs first as a type check.
 *
 * Output is a plain IIFE, not an ES module: the JSDOM-based tests inject the file with
 * `window.eval(...)` (theme-icon, cancel-flow, menu-toggle, reading-width, space-slug,
 * filing-badge), which a module script would break.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/client/app.ts')],
  outfile: path.join(root, 'public/app.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // The `browser` field in turndown's manifest drops its Node-only DOM implementation;
  // esbuild honours it automatically under platform=browser.
  logLevel: 'warning',
});
