/*
 * Reading view width regression tests.
 *
 * The reading column is limited by default (long lines on wide screens are hard to
 * read), and desktop users can drag the handle to widen or narrow it. The width must
 * be clamped so the column can never spill outside the viewport, and the preference
 * must survive a reload via localStorage.
 */
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

const storage: Record<string, string> = {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem(key: string) { return storage[key] ?? null; },
    setItem(key: string, value: string) { storage[key] = value; },
  },
  configurable: true,
});
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};
window.fetch = async (url: string) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) {
    return { ok: true, json: async () => ({
      spaces: [{ slug: 'default', title: '默认空间', desc: '', home: 'welcome', createdAt: Date.now(), updatedAt: Date.now() }],
      pages: [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎', createdAt: Date.now(), updatedAt: Date.now() }],
    }) };
  }
  return { ok: true, json: async () => ({
    slug: 'welcome', space: 'default', parent: null, title: '欢迎', content: '<h1>欢迎</h1><p>正文</p>', createdAt: Date.now(), updatedAt: Date.now(),
  }) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const rootStyle = () => document.documentElement.style.getPropertyValue('--reading-w');
const pointer = (type: string, clientX: number) =>
  new window.MouseEvent(type, { clientX, bubbles: true, cancelable: true });

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(80);

  const article = $('#article');
  assert.ok(article.classList.contains('is-reading'), 'reading view should be width-limited');
  const handle = $('.reading-handle');
  assert.equal(handle.getAttribute('role'), 'separator', 'handle should expose the separator role');
  assert.equal(rootStyle(), '760px', 'default reading width should be 760px');

  // 拖拽：正文列居中，右缘移动 dx 会让总宽度变化 2*dx
  handle.dispatchEvent(pointer('pointerdown', 500));
  handle.dispatchEvent(pointer('pointermove', 560));
  assert.equal(rootStyle(), '880px', 'dragging the handle right should widen the column');
  handle.dispatchEvent(pointer('pointerup', 560));
  assert.equal(storage['doclight-reading-width'], '880', 'width should persist after dragging');

  // 安全边界：拖到天边也不能超出可视区域
  handle.dispatchEvent(pointer('pointerdown', 560));
  handle.dispatchEvent(pointer('pointermove', 5000));
  const max = window.innerWidth - 24;
  assert.equal(rootStyle(), max + 'px', 'width should clamp to the viewport bound');
  handle.dispatchEvent(pointer('pointerup', 5000));

  // 键盘操作
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(rootStyle(), (max - 20) + 'px', 'ArrowLeft should narrow the column by one step');

  // 双击复位默认宽度
  handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(rootStyle(), '760px', 'double click should restore the default width');
  assert.equal(storage['doclight-reading-width'], '760', 'reset should persist too');

  // 编辑器铺满，不受阅读限宽影响
  $('#btn-edit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  assert.equal(article.classList.contains('is-reading'), false, 'editor should use the full width');

  console.log('reading width assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
