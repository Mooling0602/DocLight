import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// Reproduction of the reported screenshots: after choosing an explicit light/dark
// mode, every theme icon disappeared. The CSS rule
// [hidden] { display: none !important } matches on the **content attribute**,
// while `svg.hidden = x` only plants a JS expando on an SVGElement and never
// writes that attribute. Assertions must therefore read getAttribute('hidden')
// rather than the .hidden expando — reading the expando is exactly what made the
// old test immune to this bug.

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost:4173/default', pretendToBeVisual: true, runScripts: 'outside-only' });
const window = dom.window as unknown as any;
const document = window.document as Document;

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
  configurable: true,
});
window.scrollTo = () => {};
window.fetch = async (url: string) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'setup', authed: false, user: null, salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) return { ok: true, json: async () => ({ spaces: [], pages: [] }) };
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const ICONS = ['auto', 'light', 'dark'] as const;

/** An icon only counts as visible when it carries no hidden content attribute — that is what CSS matches on. */
const contentVisible = () => ICONS.filter(k => !$('#icon-' + k).hasAttribute('hidden'));

async function pick(pref: string): Promise<void> {
  click('#btn-theme');
  click(`#menu-theme [data-pref="${pref}"]`);
  await wait(20);
  const visible = contentVisible();
  assert.deepEqual(
    visible, [pref],
    `pref=${pref}: expected exactly one selectable icon (judged by the hidden content attribute), got [${visible}]; ` +
    `an empty list means svg.hidden only wrote an expando and never the content attribute`,
  );
  assert.equal(
    $('#icon-' + pref).getAttribute('hidden'), null,
    `pref=${pref}: the selected icon must not carry a hidden content attribute`,
  );
}

/** Pin down the root cause itself: SVGElement has no hidden IDL attribute, so svg.hidden is always undefined. */
function assertSvgHasNoHiddenIdl(): void {
  const svg = $('#icon-light') as unknown as { hidden?: unknown };
  assert.equal(
    Object.prototype.hasOwnProperty.call(svg, 'hidden'), false,
    'SVGElement must not expose a hidden IDL attribute — if it does, the environment changed and this test needs review',
  );
}

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(60);

  assertSvgHasNoHiddenIdl();

  // Starts out following the system appearance.
  assert.deepEqual(contentVisible(), ['auto'], 'only icon-auto should be visible by default');

  // Switching repeatedly: an explicit mode must make its own icon genuinely visible.
  await pick('light');
  await pick('dark');
  await pick('auto');
  await pick('dark');
  await pick('light');

  // The icons themselves must not render hollow.
  assert.equal($('#icon-light circle').getAttribute('fill'), 'currentColor', 'light icon should have a visible center');
  assert.equal($('#icon-dark path').getAttribute('fill'), 'currentColor', 'dark icon should have a visible fill');

  await pick('dark');
  assert.equal(window.localStorage.getItem('doclight-theme'), 'dark', 'preference should persist');
  console.log('theme icon assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
