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
const spaces: Space[] = [
  { slug: 'default', title: '默认空间', desc: '', home: null, createdAt: now, updatedAt: now },
];
// Server order is `created_desc` (DEFAULT_SORT), so the array below is what /api/tree returns.
let pages = [
  { slug: 'alpha', space: 'default', parent: null, title: '甲', createdAt: 3, updatedAt: 3 },
  { slug: 'beta', space: 'default', parent: null, title: '乙', createdAt: 2, updatedAt: 2 },
  { slug: 'gamma', space: 'default', parent: null, title: '丙', createdAt: 1, updatedAt: 1 },
];
let puts: { url: string; body: any }[] = [];
let treeCalls = 0;
// Flipped to make the sort PUT fail, so the failure branch can be exercised from other views.
let sortPutFails = false;

window.fetch = async (url: string, opts: any = {}) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) { treeCalls++; return { ok: true, json: async () => ({ spaces, pages }) }; }
  if (url.includes('/api/spaces/') && opts.method === 'PUT') {
    const body = JSON.parse(String(opts.body));
    puts.push({ url, body });
    if (sortPutFails) return { ok: false, status: 500, json: async () => ({ error: '磁盘只读' }) };
    // Mirror the server: applying a sort rewrites the space record (or drops the key for the default).
    if (body.sort === null) delete spaces[0].sort;
    else if (body.sort !== undefined) spaces[0].sort = body.sort;
    return { ok: true, json: async () => spaces[0] };
  }
  if (url.includes('/api/pages') && opts.method === 'POST') {
    const body = JSON.parse(String(opts.body));
    const created = { slug: 'delta', space: body.space, parent: body.parent, title: body.title, createdAt: 4, updatedAt: 4 };
    // The server re-sorts by the space's key, so a newest-first space puts the new page on top.
    pages = [created, ...pages];
    return { ok: true, json: async () => ({ ...created, content: '' }) };
  }
  if (url.includes('/api/pages/')) {
    const slug = decodeURIComponent(url.split('/api/pages/')[1]);
    const meta = pages.find(p => p.slug === slug);
    return { ok: true, json: async () => ({ ...meta, content: '' }) };
  }
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

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

  // Ordinary mutations must re-derive the order too, not only the sort picker. Creating a page
  // used to push onto the local array, which left the sidebar in its old order until a reload:
  // the new page belongs on top under the default key.
  const sidebarOrder = () => [...document.querySelectorAll('.tree-row .page-item .t')].map(n => n.textContent);
  assert.deepEqual(sidebarOrder(), ['甲', '乙', '丙'], '初始侧栏应按服务端顺序');
  const beforeCreate = treeCalls;
  click('#sp-add');
  await wait(20);
  const input = $('#modal-root input') as HTMLInputElement;
  input.value = '新页面';
  click('#modal-root [data-x=ok]');
  await wait(80);
  assert.ok(treeCalls > beforeCreate, '新建页面后应重新拉取 tree，而不是只改内存数组');
  assert.deepEqual(sidebarOrder(), ['新页面', '甲', '乙', '丙'], '新建后侧栏应按同一个键重排序');

  // A space with a `home` never renders the index view, so the reachable entry point is the
  // space row menu. Without it the shipped sample space (home: welcome) can't set a sort at all.
  const actions = $('.space-row .row-actions');
  const more = actions.querySelectorAll('.ra-btn')[1];
  more.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  const settings = $('#menu-row [data-act="settings"]');
  assert.ok(settings, '空间菜单应提供「空间设置」入口');
  settings!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  const modal = $('#modal-root');
  assert.equal(modal.hidden, false, '空间设置应打开');
  const settingsSelect = $('#ss-sort') as HTMLSelectElement;
  assert.ok(settingsSelect, '空间设置应含排序控件');
  assert.deepEqual([...settingsSelect.options].map(o => o.value), [...SORT_KEYS], '设置里的选项应与共享键列表一致');
  assert.equal(settingsSelect.value, DEFAULT_SORT, '设置应显示已存储的排序');

  // Layout regression: the picker reuses the index page's `.sort-pick`, but inside a modal the
  // generic `.modal select { width: 100% }` rule made the select claim the whole row and squeezed
  // the "排序" label to one character per line — a vertical two-line label. The modal rules must
  // neutralise that width so the label stays on one line beside the control.
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const modalPick = css.match(/\.modal\s+\.sort-pick\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(modalPick, 'style.css 应为弹窗里的排序控件提供作用域限定的 .modal .sort-pick 规则');
  const modalPickSelect = css.match(/\.modal\s+\.sort-pick\s+select\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(modalPickSelect, 'style.css 应限定 .modal .sort-pick select 的宽度');
  assert.match(modalPickSelect, /width:\s*auto/, '弹窗里的 select 不应继承 width:100%，否则「排序」标签会被挤成竖排');
  assert.ok(
    /display:\s*flex/.test(modalPick) && !/inline-flex/.test(modalPick),
    '弹窗里的 .sort-pick 应改用 flex 布局，让标签与控件同行分配宽度',
  );

  // Vertical alignment: `.modal select` carries `margin-bottom: 16px`, and on a flex item that
  // margin joins the centring box — with `align-items: center` the control's border box sat ~8px
  // above the label's centre line, so "排序" read as sitting low. The margin belongs on the row:
  // the control then centres against the label and the 16px rhythm below is unchanged.
  assert.match(modalPick, /margin-bottom:\s*16px/, '弹窗排序行应承接 16px 下边距，保持与其它弹窗控件的节奏一致');
  assert.match(
    modalPickSelect, /margin-bottom:\s*0/,
    '弹窗里的 select 必须清除 margin-bottom，否则 flex 居中时控件会偏离标签中心线',
  );
  // The override relies on specificity (`.modal .sort-pick select` is 0,2,1 against `.modal
  // select` at 0,1,1), not on source order — so also pin that the scoped selector really is the
  // more specific one. A future edit that drops a class here would let the 16px margin return.
  const idCount = (s: string) => (s.match(/#[\w-]+/g) || []).length;
  const classCount = (s: string) =>
    (s.match(/\.[\w-]+/g) || []).length +
    (s.match(/\[[^\]]+\]/g) || []).length +
    (s.match(/:(?!:)[\w-]+/g) || []).length;
  const scopedSelector = '.modal .sort-pick select';
  const genericSelector = '.modal select';
  assert.ok(
    idCount(scopedSelector) === idCount(genericSelector) &&
      classCount(scopedSelector) > classCount(genericSelector),
    '作用域选择器的特异性必须高于通用 .modal select，margin 归零才生效',
  );

  const putsBefore = puts.length;
  settingsSelect.value = 'title_asc';
  click('#modal-root [data-x=ok]');
  await wait(80);
  assert.equal(puts.length, putsBefore + 1, '在设置里改排序应发 PUT');
  assert.equal(puts[puts.length - 1].body.sort, 'title_asc', '设置里的 PUT 应带上所选键');

  // A failed save must not navigate. The settings entry is reachable from every route, but the
  // failure branch used to call `renderSpace` unconditionally — which clears `S.page`, hides the
  // editor and empties `#editor`. Opened from an article that replaced the reader's view; opened
  // while editing, it discarded unsaved work with no confirmation.
  const onArticle = () => document.querySelector('#cluster-view')!.hasAttribute('hidden') === false;
  click('.tree-row .page-item');
  await wait(80);
  assert.ok(onArticle(), '前置：应停在文章页');

  sortPutFails = true;
  $('.space-row .row-actions').querySelectorAll('.ra-btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  document.querySelector('#menu-row [data-act="settings"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  const failSelect = $('#ss-sort') as HTMLSelectElement;
  failSelect.value = 'created_asc';
  click('#modal-root [data-x=ok]');
  await wait(80);
  assert.ok(onArticle(), '排序保存失败后应仍停在文章页，而不是跳去空间索引');
  assert.equal($('#modal-root').hidden, true, '失败后弹窗应关闭');

  // The severe case: editing with unsaved work. The editor must survive a failed sort save.
  click('#btn-edit');
  await wait(40);
  const editor = $('#editor');
  editor.innerHTML = '<p>尚未保存的内容</p>';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('#dirty-pill').hidden, false, '前置：应处于未保存状态');

  $('.space-row .row-actions').querySelectorAll('.ra-btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  document.querySelector('#menu-row [data-act="settings"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  ($('#ss-sort') as HTMLSelectElement).value = 'updated_asc';
  click('#modal-root [data-x=ok]');
  await wait(80);
  assert.equal($('#edit-wrap').hidden, false, '排序保存失败不应退出编辑态');
  assert.match($('#editor').innerHTML, /尚未保存的内容/, '排序保存失败不应清空编辑器内容');
  assert.equal($('#dirty-pill').hidden, false, '排序保存失败不应丢弃未保存标记');
  sortPutFails = false;

  // The success path must not navigate either: only the index owns a picker to re-render, and the
  // sidebar carries the new order everywhere else. `title_asc` is already the stored value by now,
  // so pick a different key or the modal would correctly skip the PUT.
  const putsBeforeSuccess = puts.length;
  $('.space-row .row-actions').querySelectorAll('.ra-btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  document.querySelector('#menu-row [data-act="settings"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  ($('#ss-sort') as HTMLSelectElement).value = 'created_asc';
  click('#modal-root [data-x=ok]');
  await wait(120);
  assert.equal(puts.length, putsBeforeSuccess + 1, '成功路径仍应发出 PUT');
  assert.equal($('#edit-wrap').hidden, false, '从编辑器保存排序成功不应退出编辑态');
  assert.match($('#editor').innerHTML, /尚未保存的内容/, '保存排序不应影响编辑器内容');
  assert.equal($('#cluster-view').hasAttribute('hidden'), true, '不应跳转到空间索引');

  console.log('space sort assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
