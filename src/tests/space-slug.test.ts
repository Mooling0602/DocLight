/*
 * Space slug editing regression tests.
 *
 * Pages have always been renameable by slug; spaces were not, even though the
 * sidebar space menu offered the same actions shape. The flow has to (a) send the
 * new slug, (b) follow the rename in the local page metadata (pages reference their
 * space by slug), and (c) update the address bar without re-routing.
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

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
  configurable: true,
});
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};

const now = Date.now();
const spaces = [{ slug: 'default', title: '默认空间', desc: '', home: null, createdAt: now, updatedAt: now }];
const pages = [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎', createdAt: now, updatedAt: now }];
let putRequest: { url: string; method?: string; body?: unknown } | null = null;

window.fetch = async (url: string, opts: any = {}) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) return { ok: true, json: async () => ({ spaces, pages }) };
  if (url.includes('/api/spaces/') && opts.method === 'PUT') {
    putRequest = { url, method: opts.method, body: JSON.parse(String(opts.body)) };
    const updated = { ...spaces[0], slug: 'my_new_space', updatedAt: Date.now() };
    spaces[0] = updated;
    return { ok: true, json: async () => updated };
  }
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(60);

  // With home: null the space index is shown, where the slug chip lives
  const chip = $('#sp-slug-edit');
  assert.equal(chip.textContent, '#default', 'space index should expose its slug');

  // The sidebar page link is built from the page → space chain
  assert.equal($('.tree-row .page-item').getAttribute('href'), '/default/welcome', 'page link uses the space chain');

  click('#sp-slug-edit');
  await wait(20);
  const modal = $('#modal-root');
  assert.equal(modal.hidden, false, 'slug prompt should open');
  assert.match(modal.textContent || '', /编辑空间 slug/);

  const input = modal.querySelector<HTMLInputElement>('input')!;
  input.value = 'My New Space!';
  click('#modal-root [data-x=ok]');
  await wait(60);

  assert.ok(putRequest, 'a PUT should be sent');
  assert.equal(putRequest.method, 'PUT', 'slug changes go through PUT');
  assert.equal(putRequest.url, '/api/spaces/default', 'the current slug addresses the space');
  assert.deepEqual(putRequest.body, { slug: 'my_new_space' }, 'the normalized slug is sent');

  assert.equal($('#sp-slug-edit').textContent, '#my_new_space', 'the chip shows the new slug');
  assert.equal(window.location.pathname, '/my_new_space', 'the address bar follows the rename');
  assert.equal(
    document.querySelector('.space-title')!.getAttribute('href'),
    '/my_new_space',
    'the sidebar space link re-points',
  );
  assert.equal(
    $('.tree-row .page-item').getAttribute('href'),
    '/my_new_space/welcome',
    'page links follow the renamed space',
  );

  console.log('space slug assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
