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
window.navigator.clipboard = { writeText: async () => {} };
window.fetch = async (url: string) => {
  if (url.includes('/api/auth/')) {
    if (url.includes('state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
    return { ok: true, json: async () => ({ ok: true, user: 'tester' }) };
  }
  if (url.includes('/api/tree')) {
    return { ok: true, json: async () => ({
      spaces: [{ slug: 'default', title: '欢迎使用 DocLight', desc: '', home: 'welcome', createdAt: Date.now(), updatedAt: Date.now() }],
      pages: [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎使用 DocLight', createdAt: Date.now(), updatedAt: Date.now() }],
    }) };
  }
  return { ok: true, json: async () => ({
    slug: 'welcome', space: 'default', parent: null, title: '欢迎使用 DocLight', content: '<h1>欢迎使用 DocLight</h1><p>正文</p>', createdAt: Date.now(), updatedAt: Date.now(),
  }) };
};
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(50);

  $('#btn-edit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  assert.equal($('#edit-wrap').hidden, false, 'editor should open');
  assert.equal($('#cluster-edit').hidden, false, 'edit actions should appear');

  $('#editor').innerHTML = '<p>被修改的内容</p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('#dirty-pill').hidden, false, 'dirty marker should appear');

  $('#btn-cancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  const modal = $('#modal-root');
  assert.equal(modal.hidden, false, 'confirmation modal should open');
  assert.match(modal.textContent || '', /放弃修改/);

  modal.querySelector<HTMLElement>('[data-x=ok]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  assert.equal($('#edit-wrap').hidden, true, 'editor should close after cancelling');
  assert.equal($('#cluster-edit').hidden, true, 'edit actions should hide');
  assert.equal($('#article').hidden, false, 'article should be restored');
  assert.equal($('#dirty-pill').hidden, true, 'dirty marker should clear');
  assert.equal($('#toolbar-wrap').hidden, true, 'toolbar should hide');
  console.log('cancel flow assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
