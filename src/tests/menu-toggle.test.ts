import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

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

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(60);

  click('#btn-theme');
  await wait(20);
  assert.equal($('#menu-theme').hidden, false, 'theme menu should open');
  click('#btn-theme');
  await wait(20);
  assert.equal($('#menu-theme').hidden, true, 'theme menu should close');

  click('#btn-theme');
  click('#menu-theme [data-pref="light"]');
  await wait(20);
  // Assertions must read the hidden **content attribute**: SVGElement has no
  // hidden IDL attribute, so asserting on `.hidden` only reproduces the bug's
  // own side effect and says nothing about real visibility.
  assert.equal($('#icon-light').getAttribute('hidden'), null, 'light theme icon should be visible');
  assert.notEqual($('#icon-dark').getAttribute('hidden'), null, 'dark theme icon should be hidden in light mode');
  assert.equal($('#icon-light circle').getAttribute('fill'), 'currentColor', 'light icon should have a visible center');

  click('#btn-theme');
  click('#menu-theme [data-pref="dark"]');
  await wait(20);
  assert.equal($('#icon-dark').getAttribute('hidden'), null, 'dark theme icon should be visible');
  assert.notEqual($('#icon-light').getAttribute('hidden'), null, 'light theme icon should be hidden in dark mode');
  assert.equal($('#icon-dark path').getAttribute('fill'), 'currentColor', 'dark icon should have a visible fill');

  $('#cluster-view').hidden = false;
  click('#btn-more');
  await wait(20);
  const pageMenu = $('#menu-page');
  assert.equal(pageMenu.hidden, false, 'page menu should open');
  assert.equal(pageMenu.querySelectorAll('.menu-item').length, 5);
  click('#btn-more');
  await wait(20);
  assert.equal(pageMenu.hidden, true, 'page menu should close');

  click('#btn-more');
  document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  assert.equal(pageMenu.hidden, true, 'outside click should close the page menu');

  click('#btn-theme');
  await wait(20);
  click('#btn-more');
  await wait(20);
  assert.equal($('#menu-theme').hidden, true, 'menus should be mutually exclusive');
  assert.equal(pageMenu.hidden, false, 'page menu should remain open');
  console.log('menu toggle assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
