/*
 * "Recommend other articles" footer.
 *
 * A space can enable a reading-order navigation at the bottom of every article: one card each for
 * the previous and next page. Two things are easy to get wrong and are pinned here:
 *
 *   1. Order. Neighbours follow the sidebar's depth-first walk (children directly after their
 *      parent), not the flat page list, otherwise a nested page would jump to the end of space.
 *   2. Reachability. The flag lives on the space record and is saved from the space settings
 *      modal, so the switch has to send the right payload and the reader has to re-render —
 *      without ever replacing an open editor's unsaved content.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { pageNeighbors } from '../sort.js';

/* ---------------------------------------------------- reading-order helper */

const meta = (slug: string, parent: string | null = null, space = 's') => ({ slug, parent, space });

// Flat spaces read top to bottom; the ends only have one neighbour.
{
  const flat = [meta('a'), meta('b'), meta('c')];
  assert.equal(pageNeighbors(flat, 'a').prev, null);
  assert.equal(pageNeighbors(flat, 'a').next?.slug, 'b');
  assert.equal(pageNeighbors(flat, 'b').prev?.slug, 'a');
  assert.equal(pageNeighbors(flat, 'b').next?.slug, 'c');
  assert.equal(pageNeighbors(flat, 'c').next, null);
}

// Nested pages read depth-first: a child sits between its parent and the parent's next sibling.
{
  const nested = [meta('a'), meta('b'), meta('b1', 'b'), meta('b2', 'b'), meta('c')];
  assert.equal(pageNeighbors(nested, 'b').next?.slug, 'b1');
  assert.equal(pageNeighbors(nested, 'b1').prev?.slug, 'b');
  assert.equal(pageNeighbors(nested, 'b1').next?.slug, 'b2');
  assert.equal(pageNeighbors(nested, 'b2').next?.slug, 'c');
}

// Only the requested space is walked, missing slugs have no neighbours, and a hand-edited cycle
// must not hang the reader (or hide the remaining pages).
{
  assert.equal(pageNeighbors([meta('a'), meta('b', null, 'other')], 'a').next, null);
  assert.deepEqual(pageNeighbors([meta('a')], 'nope'), { prev: null, next: null });
  const cyclic = [meta('a', 'b'), meta('b', 'a'), meta('c')];
  const a = pageNeighbors(cyclic, 'a');
  assert.ok(a.prev || a.next, '环状 parent 应回退到剩余页面顺序，而不是返回空');
  assert.ok(pageNeighbors(cyclic, 'c').prev || pageNeighbors(cyclic, 'c').next);
}

/* ---------------------------------------------------- browser flow */

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost:4173/default/beta_child', pretendToBeVisual: true, runScripts: 'outside-only' });
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
const spaces: any[] = [
  { slug: 'default', title: '默认空间', desc: '', home: null, recommend: true, createdAt: now, updatedAt: now },
];
// Server order is `created_desc`: alpha, beta, gamma, then the child (a newer child would sit on
// top, which is not what the reading order should do — the tree decides, not the flat list).
const pages = [
  { slug: 'alpha', space: 'default', parent: null, title: '甲', createdAt: 5, updatedAt: 5 },
  { slug: 'beta', space: 'default', parent: null, title: '乙', createdAt: 4, updatedAt: 4 },
  { slug: 'gamma', space: 'default', parent: null, title: '丙', createdAt: 3, updatedAt: 3 },
  { slug: 'beta_child', space: 'default', parent: 'beta', title: '乙·子页', createdAt: 2, updatedAt: 2 },
];
const puts: { url: string; body: any }[] = [];

window.fetch = async (url: string, opts: any = {}) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) return { ok: true, json: async () => ({ spaces, pages }) };
  if (url.includes('/api/spaces/') && opts.method === 'PUT') {
    const body = JSON.parse(String(opts.body));
    puts.push({ url, body });
    // Mirror the server: `false` removes the key rather than persisting it.
    if (body.recommend !== undefined) {
      if (body.recommend) spaces[0].recommend = true;
      else delete spaces[0].recommend;
    }
    if (body.sort === null) delete spaces[0].sort;
    else if (body.sort !== undefined) spaces[0].sort = body.sort;
    return { ok: true, json: async () => spaces[0] };
  }
  if (url.includes('/api/pages/')) {
    const slug = decodeURIComponent(url.split('/api/pages/')[1]);
    const found = pages.find(p => p.slug === slug);
    return { ok: true, json: async () => ({ ...found, content: `# ${found?.title ?? slug}` }) };
  }
  return { ok: true, json: async () => ({}) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = (selector: string) => $(selector)!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const navCards = () => [...document.querySelectorAll('#article .page-nav-card')];

async function openSpaceSettings(): Promise<void> {
  const more = document.querySelector('.space-row .row-actions')!.querySelectorAll('.ra-btn')[1] as HTMLElement;
  more.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  click('#menu-row [data-act="settings"]');
  await wait(20);
}

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(120);

  // ---- The nested page's neighbours are its parent (previous) and the parent's sibling (next).
  assert.equal(document.title, '乙·子页 · DocLight', '前置：应停在文章页');
  const nav = $('#article .page-nav');
  assert.ok(nav, '开启推荐后，文章底部应有上一篇 / 下一篇');
  assert.equal(nav!.getAttribute('aria-label'), '上一篇 / 下一篇');
  const first = navCards();
  assert.deepEqual(first.map(card => card.querySelector('.dir')!.textContent), ['← 上一篇', '下一篇 →']);
  assert.deepEqual(first.map(card => card.querySelector('.t')!.textContent), ['乙', '丙']);
  assert.deepEqual(first.map(card => card.getAttribute('href')), ['/default/beta', '/default/gamma']);

  // ---- Clicking a card routes like any other app link.
  click('#article .page-nav-card.prev');
  await wait(100);
  assert.equal(document.title, '乙 · DocLight', '点击上一篇应打开上一页');
  const atBeta = navCards();
  assert.deepEqual(atBeta.map(card => card.querySelector('.t')!.textContent), ['甲', '乙·子页'], '父页的上一页是兄弟页，下一页是自己的首个子页');

  // ---- Boundaries render a single card, aligned on the correct side.
  click('#article .page-nav-card.prev');
  await wait(100);
  assert.equal(document.title, '甲 · DocLight');
  assert.equal(document.querySelector('#article .page-nav-card.prev'), null, '第一页没有上一篇');
  const onlyNext = navCards();
  assert.equal(onlyNext.length, 1);
  assert.equal(onlyNext[0].querySelector('.t')!.textContent, '乙');

  click('#article .page-nav-card');
  await wait(80);
  click('#article .page-nav-card.next');
  await wait(80);
  click('#article .page-nav-card.next');
  await wait(100);
  assert.equal(document.title, '丙 · DocLight', '连续下一页应走到最后一篇');
  assert.equal(document.querySelector('#article .page-nav-card.next'), null, '最后一页没有下一篇');
  assert.equal(navCards().length, 1);

  // ---- The switch persists the flag and updates the open article in place.
  const before = puts.length;
  await openSpaceSettings();
  const rec = $('#ss-recommend') as HTMLInputElement;
  assert.ok(rec, '空间设置应提供推荐开关');
  assert.equal(rec.checked, true, '开关应反映已存储的值');
  rec.checked = false;
  click('#modal-root [data-x=ok]');
  await wait(120);
  assert.equal(puts.length, before + 1, '关闭推荐应发出一次 PUT');
  assert.deepEqual(puts[puts.length - 1].body, { recommend: false }, '只应提交发生变化的字段');
  assert.equal('recommend' in spaces[0], false, '关闭后空间记录不应保留 recommend 键');
  assert.equal(document.title, '丙 · DocLight', '保存设置不应离开文章页');
  assert.equal($('#article .page-nav'), null, '关闭后底部导航应立即消失');

  // Turning it back on re-renders the article and restores both cards.
  await openSpaceSettings();
  ($('#ss-recommend') as HTMLInputElement).checked = true;
  click('#modal-root [data-x=ok]');
  await wait(120);
  assert.deepEqual(puts[puts.length - 1].body, { recommend: true });
  assert.equal(spaces[0].recommend, true);
  // The current page is the last one, so only its previous card comes back.
  assert.equal(navCards().length, 1, '重新开启后应恢复上一篇卡片');
  assert.ok($('#article .page-nav-card.prev'), '重新开启后应恢复上一篇卡片');

  // ---- The space index offers the same switch next to the sort picker.
  click('#article .crumbs a');
  await wait(120);
  assert.equal(($('#btn-auth') as HTMLElement).hidden, false, '空间总览应显示登录/退出入口');
  const indexSwitch = $('#sp-recommend') as HTMLInputElement;
  assert.ok(indexSwitch, '空间总览应提供推荐开关');
  assert.equal(indexSwitch.checked, true, '总览开关应反映已存储的值');
  const putsBeforeIndex = puts.length;
  indexSwitch.checked = false;
  indexSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(120);
  assert.equal(puts.length, putsBeforeIndex + 1, '总览开关应发出一次 PUT');
  assert.deepEqual(puts[puts.length - 1].body, { recommend: false }, '总览开关只应提交该字段');
  assert.equal('recommend' in spaces[0], false);
  assert.equal(($('#sp-recommend') as HTMLInputElement).checked, false, '保存后开关应反映新状态');
  // Turning it back on from the index works the same way and re-renders the switch.
  ($('#sp-recommend') as HTMLInputElement).checked = true;
  ($('#sp-recommend') as HTMLInputElement).dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(120);
  assert.deepEqual(puts[puts.length - 1].body, { recommend: true });
  assert.equal(($('#sp-recommend') as HTMLInputElement).checked, true);
  click('.cards a.card');
  await wait(120);
  assert.equal(($('#btn-auth') as HTMLElement).hidden, false, '文章预览应显示登录或退出入口');

  // ---- An open editor must survive a settings save: the footer is a reading-view concern.
  click('#btn-edit');
  await wait(50);
  assert.equal(($('#btn-auth') as HTMLElement).hidden, true, '编辑期间隐藏账号入口');
  $('#editor')!.innerHTML = '<p>尚未保存的内容</p>';
  $('#editor')!.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(($('#dirty-pill') as HTMLElement).hidden, false, '前置：应处于未保存状态');
  await openSpaceSettings();
  ($('#ss-recommend') as HTMLInputElement).checked = false;
  click('#modal-root [data-x=ok]');
  await wait(120);
  assert.equal(($('#edit-wrap') as HTMLElement).hidden, false, '不应退出编辑态');
  assert.match($('#editor')!.innerHTML, /尚未保存的内容/, '不应丢弃未保存的内容');
  assert.equal(($('#dirty-pill') as HTMLElement).hidden, false, '未保存标记应保留');

  // ---- Layout guards. The cards must not be plain paragraphs: two columns, next aligned right.
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const pageNav = css.match(/\.page-nav\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(pageNav, /display:\s*grid/, '上一篇 / 下一篇应为网格布局');
  assert.match(pageNav, /grid-template-columns:\s*1fr 1fr/, '两栏布局');
  const nextCard = css.match(/\.page-nav-card\.next\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(nextCard, /grid-column:\s*2/, '只有下一页时卡片应靠右');
  assert.match(css, /\.switch-ui\s*\{[^}]*border-radius:\s*99px/, '开关应有药丸形轨道');
  assert.match(css, /\.switch-row input:checked \+ \.switch-ui/, '开关应有开启态样式');
  assert.match(css, /\.switch-inline\s*\{[^}]*display:\s*inline-flex/, '空间总览的开关应与排序控件同行');
  assert.match(css, /\.switch-inline input:checked \+ \.switch-ui/, '总览开关应有开启态样式');

  console.log('space recommend assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
