/*
 * Sidebar order picker.
 *
 * Order used to be whatever `readdirSync` returned, which is creation order only on small ext4
 * directories and hash order on APFS/NTFS or once a directory gains an htree — so the sidebar could
 * reshuffle for no reason the user could see. The order is now a per-space setting; this suite
 * covers the client half: the picker reflects the stored value, changing it sends the key the API
 * expects, and the tree is refetched rather than re-sorted locally (one definition of the order).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { DEFAULT_SORT, SORT_KEYS, SORT_LABELS } from '../sort.js';
import type { Space } from '../store.js';

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
const spaces: Space[] = [{ slug: 'default', title: '默认空间', desc: '', home: null, createdAt: now, updatedAt: now }];
const pages = [
  { slug: 'alpha', space: 'default', parent: null, title: '甲', createdAt: 3, updatedAt: 3 },
  { slug: 'beta', space: 'default', parent: null, title: '乙', createdAt: 2, updatedAt: 2 },
  { slug: 'gamma', space: 'default', parent: null, title: '丙', createdAt: 1, updatedAt: 1 },
];
let puts: { url: string; body: any }[] = [];
let treeCalls = 0;

window.fetch = async (url: string, opts: any = {}) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) { treeCalls++; return { ok: true, json: async () => ({ spaces, pages }) }; }
  if (url.includes('/api/spaces/') && opts.method === 'PUT') {
    const body = JSON.parse(String(opts.body));
    puts.push({ url, body });
    // Mirror the server: applying a sort rewrites the space record (or drops the key for the default).
    if (body.sort === null) delete spaces[0].sort;
    else if (body.sort !== undefined) spaces[0].sort = body.sort;
    return { ok: true, json: async () => spaces[0] };
  }
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(60);

  const select = $<HTMLSelectElement>('#sp-sort');
  assert.ok(select, '空间总览应提供排序控件');

  // Every key is offered exactly once, with its label; the value stays the stable enum.
  const options = [...select.options];
  assert.deepEqual(options.map(o => o.value), [...SORT_KEYS], '排序选项应与共享的键列表一致');
  for (const o of options) assert.equal(o.textContent, SORT_LABELS[o.value as keyof typeof SORT_LABELS], `${o.value} 应有对应文案`);

  // No stored preference means the default is shown selected.
  assert.equal(select.value, DEFAULT_SORT, '未设置时应显示默认排序');

  // Changing it sends the chosen key and refetches the tree instead of re-sorting locally.
  const before = treeCalls;
  select.value = 'title_asc';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  assert.equal(puts.length, 1, '改排序应发出一次 PUT');
  assert.equal(puts[0].body.sort, 'title_asc', 'PUT 应带上所选排序键');
  assert.ok(treeCalls > before, '改排序后应重新拉取 tree（顺序由服务端计算）');

  // Choosing the default clears the field rather than pinning the current default into the file.
  const select2 = $<HTMLSelectElement>('#sp-sort');
  select2.value = DEFAULT_SORT;
  select2.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  assert.equal(puts.length, 2, '再次修改应再发一次 PUT');
  assert.equal(puts[1].body.sort, null, '选回默认应以 null 清除该键，而不是写入默认值');
  assert.equal('sort' in spaces[0], false, '清除后空间记录不应留下 sort 字段');

  // The control is reachable and labelled for assistive tech, not just visually adjacent.
  assert.equal(select2.title, '侧栏与总览的页面顺序', '排序控件应有说明');
  const label = select2.closest('label');
  assert.ok(label && label.textContent!.includes('排序'), '排序控件应由 label 包裹');

  console.log('space sort assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
