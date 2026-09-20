/*
 * Verify the published tarball contents.
 *
 * package.json's `files` whitelist decides what `npm pack` ships, and it has to override
 * .gitignore for keys such as `dist/` and `public/app.js`. An edit to that whitelist can
 * therefore silently drop a compiled file: the build still succeeds locally and the
 * published package would crash on start. This check pins the exact file list.
 *
 * `dist/tests/` must never ship: the compiled tests require jsdom, a devDependency that
 * is pruned from the packed output.
 *
 * Run from the repository root after `npm run build`:
 *   node .github/workflows/scripts/check-package.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const EXPECTED = [
  'README.md',
  'package.json',
  'dist/beian.js',
  'dist/config.js',
  'dist/markdown.js',
  'dist/server.js',
  'dist/sort.js',
  'dist/store.js',
  'public/app.js',
  'public/index.html',
  'public/style.css',
  'template/pages/changelog.md',
  'template/pages/guide.md',
  'template/pages/welcome.md',
  'template/spaces.json',
];

function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out)[0].files.map((f) => f.path).sort();
}

const actual = packedFiles();
const actualSet = new Set(actual);
const missing = EXPECTED.filter((p) => !actualSet.has(p));
const leaked = actual.filter((p) => p.startsWith('dist/tests/'));
const extra = actual.filter((p) => !EXPECTED.includes(p));

if (missing.length || leaked.length || extra.length) {
  if (missing.length) console.error('缺少必需文件：\n  ' + missing.join('\n  '));
  if (leaked.length) console.error('测试产物不应打包：\n  ' + leaked.join('\n  '));
  if (extra.length) console.error('出现白名单之外的文件：\n  ' + extra.join('\n  '));
  process.exit(1);
}

console.log(`包内容检查通过：${actual.length} 个文件`);
