/*
 * Manual card ordering: drag the space index cards with a mouse or a finger.
 *
 * The preview is pure DOM (lifted card + dashed placeholder + FLIP animation); only the drop writes
 * to the API, sending the full slug order and switching the space to manual sort on the first drag.
 * The tests pin the ordering rules, the payload, the DOM preview and the rebuilt order, plus the
 * read-only spaces that must not expose drag handles.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { SORT_KEYS, SORT_LABELS, applyManualOrder } from '../sort.js';

/* ---------------------------------------------------- ordering helper */

{
  const pages = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.deepEqual(applyManualOrder(pages, ['c', 'a']).map(p => p.slug), ['c', 'a', 'b'], '列出的页面按 order 排序，未列出的保持原相对顺序');
  assert.deepEqual(applyManualOrder(pages).map(p => p.slug), ['a', 'b', 'c'], '未设置 order 时保持原顺序');
  assert.deepEqual(applyManualOrder(pages, ['missing', 'b']).map(p => p.slug), ['b', 'a', 'c'], '未知 slug 只占用序号，不影响现有页面');
  assert.deepEqual(applyManualOrder([], ['a']), []);
}

assert.ok((SORT_KEYS as readonly string[]).includes('manual'), '排序键应包含 manual');
assert.equal(SORT_LABELS.manual, '手动排序');

/* ---------------------------------------------------- browser drag flow */

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');

interface Harness {
  window: any;
  document: Document;
  spaces: any[];
  pages: any[];
  puts: { url: string; body: any }[];
}

async function boot(url: string, locked = false, extraPages: any[] = [], configureWindow?: (window: any) => void): Promise<Harness> {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window as any;
  configureWindow?.(window);
  const document = window.document as Document;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, 'localStorage', {
    value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
    configurable: true,
  });
  window.scrollTo = () => {};
  window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};

  const now = Date.now();
  const spaces: any[] = [{
    slug: 'default', title: '默认空间', desc: '', home: null,
    ...(locked ? { locked: true } : {}),
    createdAt: now, updatedAt: now,
  }];
  let pages: any[] = [
    { slug: 'alpha', space: 'default', parent: null, title: '甲', createdAt: 3, updatedAt: 3 },
    { slug: 'beta', space: 'default', parent: null, title: '乙', createdAt: 2, updatedAt: 2 },
    { slug: 'gamma', space: 'default', parent: null, title: '丙', createdAt: 1, updatedAt: 1 },
    ...extraPages,
  ];
  const puts: { url: string; body: any }[] = [];

  window.fetch = async (url: string, opts: any = {}) => {
    if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
    if (url.includes('/api/tree')) return { ok: true, json: async () => ({ spaces, pages }) };
    if (url.includes('/api/spaces/') && opts.method === 'PUT') {
      const body = JSON.parse(String(opts.body));
      puts.push({ url, body });
      if (body.sort !== undefined) spaces[0].sort = body.sort;
      if (body.order !== undefined) {
        spaces[0].order = body.order;
        // Mirror the server: the tree comes back in the new manual order.
        const ranked = body.order.map((slug: string) => pages.find(p => p.slug === slug)).filter(Boolean);
        pages = [...ranked, ...pages.filter(p => !body.order.includes(p.slug))];
      }
      return { ok: true, json: async () => spaces[0] };
    }
    if (url.includes('/api/pages/')) {
      const slug = decodeURIComponent(url.split('/api/pages/')[1]);
      const found = pages.find(p => p.slug === slug);
      return { ok: true, json: async () => ({ ...found, content: `# ${found?.title ?? slug}` }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  return { window, document, spaces, pages, puts };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Advance animation frames deterministically without a browser layout engine. */
function mockFrames(window: any) {
  let nextId = 1, now = 0;
  const pending = new Map<number, (time: number) => void>();
  window.requestAnimationFrame = (callback: (time: number) => void) => { const id = nextId++; pending.set(id, callback); return id; };
  window.cancelAnimationFrame = (id: number) => pending.delete(id);
  return {
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        now += 1000 / 60;
        const callbacks = [...pending.values()]; pending.clear();
        callbacks.forEach(callback => callback(now));
      }
    },
  };
}

/** Give the cards a vertical layout that jsdom does not compute on its own. */
function layoutCards(document: Document): void {
  const cards = [...document.querySelectorAll<HTMLElement>('#article .card')];
  cards.forEach((card, index) => {
    const rect = { left: 20, top: index * 120, right: 320, bottom: index * 120 + 100, width: 300, height: 100, x: 20, y: index * 120 };
    card.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  });
}

function pointer(window: any, type: string, x: number, y: number, target: EventTarget) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  target.dispatchEvent(event);
  return event;
}

async function main(): Promise<void> {
  /* ---- A normal drag reorders the cards and switches the space to manual sort. ---- */
  {
    const { window, document, spaces, puts } = await boot('http://localhost:4173/default');
    await wait(120);
    const titles = () => [...document.querySelectorAll('#article .card .t')].map(node => node.textContent);
    assert.deepEqual(titles(), ['甲', '乙', '丙'], '前置：默认排序按 createdAt 降序');
    const sortSelect = document.querySelector<HTMLSelectElement>('#sp-sort')!;
    assert.ok([...sortSelect.options].some(option => option.value === 'manual'), '排序下拉框应提供手动排序');
    const grips = document.querySelectorAll('#article .card-grip');
    assert.equal(grips.length, 3, '可编辑空间的每张卡片都应有拖动手柄');

    layoutCards(document);
    const first = document.querySelectorAll<HTMLElement>('#article .card')[0];
    // Press the grip, move past the threshold towards the end, then drop.
    pointer(window, 'pointerdown', 30, 20, first.querySelector('.card-grip')!);
    // Keep x to the right of the cards' midpoints so the drop goes past the last card rather than
    // before the row the pointer happens to be over.
    pointer(window, 'pointermove', 300, 320, window);
    assert.ok(document.querySelector('#article .card-placeholder'), '拖动中应出现虚线占位');
    assert.ok(first.classList.contains('is-dragging'), '被拖动的卡片应抬起');
    pointer(window, 'pointerup', 300, 320, window);

    // The click that follows a drop must not navigate.
    pointer(window, 'click', 300, 320, first);

    await wait(160);
    assert.equal(document.title, '默认空间 · DocLight', '拖动结束后不应误触链接');
    assert.equal(puts.length, 1, '放下后应提交一次顺序');
    assert.deepEqual(puts[0].body, { sort: 'manual', order: ['beta', 'gamma', 'alpha'] }, '首次拖动应切换手动排序并提交完整顺序');
    assert.equal(spaces[0].sort, 'manual');
    assert.deepEqual(titles(), ['乙', '丙', '甲'], '保存后卡片应保持新顺序');
    assert.equal(document.querySelector<HTMLSelectElement>('#sp-sort')!.value, 'manual', '排序下拉框应显示手动排序');
    assert.match(document.querySelector('#toasts')?.textContent || '', /排序已更新/, '顺序真正变化后应提示已更新');

    // A second drag keeps manual mode: only the order is sent.
    layoutCards(document);
    const cards = [...document.querySelectorAll<HTMLElement>('#article .card')];
    pointer(window, 'pointerdown', 30, 140, cards[1].querySelector('.card-grip')!);
    pointer(window, 'pointermove', 30, 40, window);
    pointer(window, 'pointerup', 30, 40, window);
    await wait(160);
    assert.deepEqual(puts[puts.length - 1].body, { order: ['gamma', 'beta', 'alpha'] }, '手动模式下再次拖动只提交 order');
  }

  /* ---- Card drags preserve the existing order of every nested subtree. ---- */
  {
    const { window, document, spaces, puts } = await boot('http://localhost:4173/default', false, [
      { slug: 'alpha_two', space: 'default', parent: 'alpha', title: '甲·二', createdAt: 1, updatedAt: 1 },
      { slug: 'alpha_grandchild', space: 'default', parent: 'alpha_two', title: '甲·孙', createdAt: 1, updatedAt: 1 },
      { slug: 'alpha_one', space: 'default', parent: 'alpha', title: '甲·一', createdAt: 2, updatedAt: 2 },
    ]);
    await wait(120);
    spaces[0].sort = 'manual';
    spaces[0].order = ['alpha', 'alpha_two', 'alpha_grandchild', 'alpha_one', 'beta', 'gamma'];
    layoutCards(document);
    const first = document.querySelectorAll<HTMLElement>('#article .card')[0];
    pointer(window, 'pointerdown', 30, 20, first.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 40, 30, window);
    pointer(window, 'pointerup', 40, 30, window);
    await wait(80);
    assert.equal(puts.length, 0, '包含子页面时原位放下也不得写入');
    layoutCards(document);
    pointer(window, 'pointerdown', 30, 20, first.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 300, 320, window);
    pointer(window, 'pointerup', 300, 320, window);
    await wait(160);
    assert.deepEqual(puts[0].body, { order: ['beta', 'gamma', 'alpha', 'alpha_two', 'alpha_grandchild', 'alpha_one'] }, '卡片拖动必须保留完整子树与其原有顺序');
    const sideTitles = [...document.querySelectorAll('#page-list .tree-row .page-item .t')].map(node => node.textContent);
    assert.deepEqual(sideTitles, ['乙', '丙', '甲', '甲·二', '甲·孙', '甲·一'], '刷新树后侧栏仍按子树原顺序显示');
    window.close();
  }

  /* ---- Child cards live in their own navigable index and retain sibling drag ordering. ---- */
  {
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [
      { slug: 'alpha_one', space: 'default', parent: 'alpha', title: '子一', createdAt: 2, updatedAt: 2 },
      { slug: 'alpha_two', space: 'default', parent: 'alpha', title: '子二', createdAt: 1, updatedAt: 1 },
      { slug: 'alpha_grand', space: 'default', parent: 'alpha_one', title: '孙页', createdAt: 1, updatedAt: 1 },
    ]);
    await wait(120);
    const card = (slug: string) => document.querySelector<HTMLElement>(`.space-page-card[data-slug="${slug}"]`);
    const enter = (slug: string) => card(slug)!.querySelector<HTMLAnchorElement>(':scope > .card-expand')!.click();
    assert.equal(card('alpha_one'), null, '空间首页只显示顶层卡片');
    enter('alpha');
    await wait(50);
    assert.equal(window.location.pathname + window.location.search, '/default/alpha?view=children');
    assert.ok(card('alpha_one') && card('alpha_two'), '独立视图显示直接子页面');
    assert.equal(card('alpha'), null, '子页面视图不嵌套父卡片');
    assert.equal(card('alpha_grand'), null, '孙页面不会混入当前层');
    assert.equal(document.querySelector('#article h1')?.textContent, '甲的子页面');
    assert.equal(puts.length, 0, '浏览子页面不得写入');
    enter('alpha_one');
    await wait(50);
    assert.ok(card('alpha_grand'), '可以逐层进入孙页面视图');
    assert.equal(document.querySelectorAll('#article .crumbs a').length, 2, '面包屑应提供空间和父级入口');
    document.querySelectorAll<HTMLAnchorElement>('#article .crumbs a')[1].click();
    await wait(50);
    assert.ok(card('alpha_one') && card('alpha_two'), '面包屑可返回父级卡片列表');
    window.history.back();
    await wait(80);
    assert.ok(card('alpha_grand'), '浏览器后退恢复上一层视图');
    window.history.forward();
    await wait(80);
    assert.ok(card('alpha_one') && card('alpha_two'), '浏览器前进恢复子页面列表');
    layoutCards(document);
    const first = card('alpha_one')!;
    pointer(window, 'pointerdown', 30, 20, first.querySelector(':scope > .card-grip')!);
    pointer(window, 'pointermove', 300, 240, window);
    pointer(window, 'pointerup', 300, 240, window);
    await wait(160);
    assert.deepEqual(puts[0].body, { sort: 'manual', order: ['alpha', 'alpha_two', 'alpha_one', 'alpha_grand', 'beta', 'gamma'] }, '子页面拖动只排序同级并保留完整子树');
    assert.ok(card('alpha_two'), '排序后保持子页面视图');
    card('alpha_two')!.querySelector<HTMLAnchorElement>(':scope > .card-link')!.click();
    await wait(120);
    assert.equal(document.title, '子二 · DocLight', '点击卡片主体打开文章');
    window.close();
  }

  /* ---- A child index URL works when opened directly, including an empty index. ---- */
  {
    const { window, document } = await boot('http://localhost:4173/default/alpha?view=children', false, [
      { slug: 'alpha_child', space: 'default', parent: 'alpha', title: '子页', createdAt: 1, updatedAt: 1 },
    ]);
    await wait(120);
    assert.ok(document.querySelector('.space-page-card[data-slug="alpha_child"]'), '直接打开地址应显示子页面卡片');
    assert.equal(document.querySelector('.space-page-card[data-slug="beta"]'), null);
    window.close();
    const empty = await boot('http://localhost:4173/default/beta?view=children');
    await wait(120);
    assert.match(empty.document.querySelector('#article')?.textContent || '', /此页面还没有子页面/);
    empty.window.close();
  }

  /* ---- Read-only spaces still expose child indexes but never sorting. ---- */
  {
    const { window, document } = await boot('http://localhost:4173/default', true, [
      { slug: 'locked_child', space: 'default', parent: 'alpha', title: '只读子页', createdAt: 1, updatedAt: 1 },
    ]);
    await wait(120);
    document.querySelector<HTMLAnchorElement>('.space-page-card[data-slug="alpha"] > .card-expand')!.click();
    await wait(50);
    assert.ok(document.querySelector('.space-page-card[data-slug="locked_child"] > .card-link'), '只读空间也可查看子页面');
    assert.equal(document.querySelectorAll('#article .card-grip').length, 0, '只读空间的子页面也不能拖动');
    window.close();
  }

  /* ---- A stationary pointer near a card viewport edge scrolls and updates the drop slot. ---- */
  {
    let frames!: ReturnType<typeof mockFrames>;
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `extra_${i}`, space: 'default', parent: null, title: `额外${i}`, createdAt: 0, updatedAt: 0 })),
    ], w => { frames = mockFrames(w); });
    await wait(120);
    const area = document.querySelector<HTMLElement>('.scroll-area')!;
    Object.defineProperties(area, { clientHeight: { value: 300 }, scrollHeight: { value: 1400 } });
    area.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    [...document.querySelectorAll<HTMLElement>('#article .space-page-card')].forEach((card, index) => {
      card.getBoundingClientRect = () => {
        const top = index * 120 - area.scrollTop;
        return { left: 20, top, right: 320, bottom: top + 100, width: 300, height: 100, x: 20, y: top, toJSON() {} } as DOMRect;
      };
    });
    const card = document.querySelector<HTMLElement>('.space-page-card[data-slug="alpha"]')!;
    pointer(window, 'pointerdown', 30, 20, card.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 300, 295, window);
    const slot = () => document.querySelector('#article .card-placeholder')?.nextElementSibling?.getAttribute('data-slug');
    const before = slot();
    frames.step(12);
    assert.ok(area.scrollTop > 0, '指针停在底部时内容区应持续向下滚动');
    assert.notEqual(slot(), before, '内容滚动后应更新卡片落点');
    pointer(window, 'pointermove', 300, 150, window);
    const centeredAt = area.scrollTop;
    frames.step(5);
    assert.equal(area.scrollTop, centeredAt, '指针离开边缘后应停止滚动');
    area.scrollTop = 1100;
    pointer(window, 'pointermove', 300, 295, window);
    frames.step(5);
    assert.equal(area.scrollTop, 1100, '滚动到底后不得越界');
    pointer(window, 'pointercancel', 300, 295, window);
    const stoppedAt = area.scrollTop;
    frames.step(5);
    assert.equal(area.scrollTop, stoppedAt, '取消拖拽后必须停止自动滚动');
    assert.equal(puts.length, 0, '取消拖拽不得提交排序');

    area.scrollTop = 150;
    const third = document.querySelector<HTMLElement>('.space-page-card[data-slug="gamma"]')!;
    pointer(window, 'pointerdown', 30, 110, third.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 30, 1, window);
    frames.step(8);
    assert.ok(area.scrollTop < 150, '指针停在顶部时内容区应向上滚动');
    pointer(window, 'pointerup', 30, 1, window);
    const releasedAt = area.scrollTop;
    frames.step(5);
    assert.equal(area.scrollTop, releasedAt, '放下后必须停止自动滚动');
    await wait(160);
    assert.equal(puts.length, 1, '自动滚动后放下应正常提交排序');
    window.close();
  }

  /* ---- Rounded scroll offsets must not stall a pointer just inside the edge. ---- */
  {
    let frames!: ReturnType<typeof mockFrames>;
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [], w => { frames = mockFrames(w); });
    await wait(120);
    const area = document.querySelector<HTMLElement>('.scroll-area')!;
    let scrollTop = 30;
    Object.defineProperties(area, {
      clientHeight: { value: 300 }, scrollHeight: { value: 600 },
      scrollTop: { get: () => scrollTop, set: value => { scrollTop = Math.round(value); } },
    });
    area.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    layoutCards(document);
    const card = document.querySelector<HTMLElement>('.space-page-card[data-slug="alpha"]')!;
    pointer(window, 'pointerdown', 30, 20, card.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 30, 245, window); // one pixel inside the 56px bottom edge
    frames.step(12);
    assert.ok(scrollTop > 30, '滚动位置被取整时，停在底部边缘仍应持续向下滚动');
    const bottom = scrollTop;
    pointer(window, 'pointermove', 30, 55, window); // one pixel inside the top edge
    frames.step(12);
    assert.ok(scrollTop < bottom, '反向后应丢弃先前余量并持续向上滚动');
    pointer(window, 'pointermove', 30, 150, window);
    const centered = scrollTop;
    frames.step(12);
    assert.equal(scrollTop, centered, '离开边缘时应停止');
    pointer(window, 'pointercancel', 30, 150, window);
    frames.step(12);
    assert.equal(scrollTop, centered, '取消后不得继续滚动');
    assert.equal(puts.length, 0);
    window.close();
  }

  /* ---- Sidebar autoscroll updates both the target and its content-relative indicator. ---- */
  {
    let frames!: ReturnType<typeof mockFrames>;
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `side_${i}`, space: 'default', parent: null, title: `目录${i}`, createdAt: 0, updatedAt: 0 })),
    ], w => { frames = mockFrames(w); });
    await wait(120);
    const list = document.querySelector<HTMLElement>('#page-list')!;
    Object.defineProperties(list, { clientHeight: { value: 200 }, scrollHeight: { value: 800 } });
    list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 260, bottom: 200, width: 260, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    [...list.querySelectorAll<HTMLElement>('.tree-row')].forEach((row, index) => {
      row.getBoundingClientRect = () => {
        const top = index * 80 - list.scrollTop;
        return { left: 0, top, right: 260, bottom: top + 60, width: 260, height: 60, x: 0, y: top, toJSON() {} } as DOMRect;
      };
    });
    const first = list.querySelector<HTMLElement>('.tree-row')!;
    pointer(window, 'pointerdown', 20, 20, first.querySelector('.tree-grip')!);
    pointer(window, 'pointermove', 20, 195, window);
    const initialTarget = list.querySelector('.tree-row.is-drop-target')?.getAttribute('data-slug');
    frames.step(12);
    assert.ok(list.scrollTop > 0, '侧边栏底部应自动滚动');
    const target = list.querySelector<HTMLElement>('.tree-row.is-drop-target')!;
    assert.notEqual(target.dataset.slug, initialTarget, '滚动时侧栏目标行应更新');
    const indicator = list.querySelector<HTMLElement>('.tree-drop')!;
    const targetRect = target.getBoundingClientRect();
    const markerTop = parseFloat(indicator.style.top);
    assert.ok(Math.abs(markerTop - (targetRect.top + list.scrollTop - 1)) < 1 || Math.abs(markerTop - (targetRect.bottom + list.scrollTop - 1)) < 1, '插入线位置必须包含滚动偏移');
    pointer(window, 'pointercancel', 20, 195, window);
    const stoppedAt = list.scrollTop;
    frames.step(5);
    assert.equal(list.scrollTop, stoppedAt, '取消侧栏拖拽应停止滚动');
    assert.equal(puts.length, 0);
    list.scrollTop = 160;
    const third = list.querySelector<HTMLElement>('.tree-row[data-slug="gamma"]')!;
    pointer(window, 'pointerdown', 20, 20, third.querySelector('.tree-grip')!);
    pointer(window, 'pointermove', 20, 1, window);
    frames.step(8);
    assert.ok(list.scrollTop < 160, '侧边栏顶部应自动向上滚动');
    pointer(window, 'pointerup', 20, 1, window);
    const releasedAt = list.scrollTop;
    frames.step(5);
    assert.equal(list.scrollTop, releasedAt, '侧边栏放下后应停止滚动');
    await wait(160);
    assert.equal(puts.length, 1, '侧边栏自动滚动后放下应提交顺序');
    window.close();
  }

  /* ---- A stale card list must not recurse or submit duplicate page slugs. ---- */
  {
    const { window, document, pages, puts } = await boot('http://localhost:4173/default');
    await wait(120);
    layoutCards(document);
    const first = document.querySelectorAll<HTMLElement>('#article .card')[0];
    // The cards were rendered before the in-memory tree became inconsistent.
    pages.find(page => page.slug === 'gamma')!.parent = 'gamma';
    pointer(window, 'pointerdown', 30, 20, first.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 300, 320, window);
    pointer(window, 'pointerup', 300, 320, window);
    await wait(160);
    assert.deepEqual(puts[0].body, { sort: 'manual', order: ['beta', 'gamma', 'alpha'] }, '异常页面树不得造成递归或重复 slug');
    window.close();
  }

  /* ---- Dropping a card back into its own slot writes nothing. ---- */
  {
    const { window, document, spaces, puts } = await boot('http://localhost:4173/default');
    await wait(120);
    const before = spaces[0].updatedAt;
    layoutCards(document);
    const card = document.querySelectorAll<HTMLElement>('#article .card')[0];
    pointer(window, 'pointerdown', 30, 20, card.querySelector('.card-grip')!);
    pointer(window, 'pointermove', 40, 30, window); // past the threshold, still in the first slot
    pointer(window, 'pointerup', 40, 30, window);
    await wait(160);
    assert.equal(puts.length, 0, '顺序未变时不应提交任何请求');
    assert.equal(spaces[0].sort, undefined, '顺序未变时不应切换到手动排序');
    assert.equal(spaces[0].updatedAt, before, '顺序未变时不应改动 updatedAt');
    assert.match(document.querySelector('#toasts')?.textContent || '', /排序无变化/, '顺序未变时应提示排序无变化');
    assert.deepEqual([...document.querySelectorAll('#article .card .t')].map(node => node.textContent), ['甲', '乙', '丙'], '卡片保持原顺序');
  }

  /* ---- Sidebar drag: siblings reorder, and the dragged page keeps its subtree. ---- */
  {
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [
      { slug: 'gamma_child', space: 'default', parent: 'gamma', title: '丙·子', createdAt: 0.5, updatedAt: 0.5 },
    ]);
    await wait(120);
    const rows = () => [...document.querySelectorAll('#page-list .tree-row')].map(node => node as HTMLElement);
    const titles = () => rows().map(row => row.querySelector('.page-item .t')?.textContent);
    assert.deepEqual(titles(), ['甲', '乙', '丙', '丙·子'], '前置：侧栏按树顺序显示');
    assert.equal(document.querySelectorAll('#page-list .tree-grip').length, 4, '可编辑空间的每个侧栏行都应有拖动手柄');
    rows().forEach((row, index) => {
      const rect = { left: 0, top: index * 40, right: 260, bottom: index * 40 + 36, width: 260, height: 36, x: 0, y: index * 40 };
      row.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
    });
    pointer(window, 'pointerdown', 40, 12, rows()[0].querySelector('.tree-grip')!);
    pointer(window, 'pointermove', 40, 200, window);
    const drop = document.querySelector('#page-list .tree-drop');
    assert.ok(drop, '侧栏拖动时应显示虚线插入指示');
    assert.equal(drop!.parentElement?.id, 'page-list', '插入线应作为浮层覆盖在列表上，不挤动行');
    assert.equal((drop!.textContent || '').trim(), '', '插入指示应由图形绘制，不使用字符');
    const highlighted = document.querySelector('#page-list .tree-row.is-drop-target');
    assert.ok(highlighted, '插入位置对应的行应被高亮');
    assert.equal(highlighted!.querySelector('.page-item .t')?.textContent, '丙·子', '高亮行应是插入线所在的行');
    assert.ok(rows()[0].classList.contains('is-dragging'), '被拖动的行应半透明');
    pointer(window, 'pointerup', 40, 200, window);
    await wait(160);
    assert.deepEqual(puts[puts.length - 1].body, { sort: 'manual', order: ['beta', 'gamma', 'gamma_child', 'alpha'] }, '整棵子树应跟随父页面保持相邻');
    assert.deepEqual(titles(), ['乙', '丙', '丙·子', '甲'], '保存后侧栏应重排');
  }

  /* ---- A sidebar drop back into its own slot is a no-op as well. ---- */
  {
    const { window, document, spaces, puts } = await boot('http://localhost:4173/default');
    await wait(120);
    const rows = () => [...document.querySelectorAll('#page-list .tree-row')].map(node => node as HTMLElement);
    rows().forEach((row, index) => {
      const rect = { left: 0, top: index * 40, right: 260, bottom: index * 40 + 36, width: 260, height: 36, x: 0, y: index * 40 };
      row.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
    });
    const before = spaces[0].updatedAt;
    pointer(window, 'pointerdown', 30, 12, rows()[0].querySelector('.tree-grip')!);
    pointer(window, 'pointermove', 30, 20, window); // still above the first sibling's midpoint
    pointer(window, 'pointerup', 30, 20, window);
    await wait(160);
    assert.equal(puts.length, 0, '侧栏顺序未变时不应提交任何请求');
    assert.equal(spaces[0].updatedAt, before, '侧栏顺序未变时不应改动 updatedAt');
    assert.match(document.querySelector('#toasts')?.textContent || '', /排序无变化/, '侧栏顺序未变时应提示排序无变化');
  }

  /* ---- Touch: the grip drags at once, while a press on the row itself stays a link tap. ---- */
  {
    const { window, document, puts } = await boot('http://localhost:4173/default');
    await wait(120);
    const rows = [...document.querySelectorAll('#page-list .tree-row')].map(node => node as HTMLElement);
    rows.forEach((row, index) => {
      const rect = { left: 0, top: index * 40, right: 260, bottom: index * 40 + 36, width: 260, height: 36, x: 0, y: index * 40 };
      row.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
    });
    const touchPress = (target: Element, x: number, y: number) => {
      const press = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(press, 'pointerType', { value: 'touch' });
      target.dispatchEvent(press);
    };

    // Pressing the row body must not arm a drag: on a touch screen that gesture belongs to the
    // browser's own link menu, which is the whole reason the handle exists.
    touchPress(rows[1].querySelector('.page-item')!, 40, 52);
    pointer(window, 'pointermove', 40, 8, window);
    assert.equal(document.querySelector('#page-list .tree-drop'), null, '按住行本体不应进入拖动');
    pointer(window, 'pointerup', 40, 8, window);
    await wait(80);
    assert.equal(puts.length, 0, '按住行本体不应提交顺序');

    // The handle needs no long press: the drag starts as soon as the pointer moves.
    touchPress(rows[1].querySelector('.tree-grip')!, 40, 52);
    pointer(window, 'pointermove', 40, 8, window);
    assert.ok(document.querySelector('#page-list .tree-drop'), '触摸拖动手柄应立即显示插入线');
    pointer(window, 'pointerup', 40, 8, window);
    await wait(160);
    assert.deepEqual(puts[puts.length - 1].body, { sort: 'manual', order: ['beta', 'alpha', 'gamma'] }, '触摸拖动手柄应重排');
  }

  /* ---- Locked spaces render cards but no drag handles. ---- */
  {
    const harness = await boot('http://localhost:4173/default', true);
    const { window, document, puts } = harness;
    await wait(120);
    assert.ok(document.querySelector('#article .card'), '锁定空间仍应显示卡片');
    assert.equal(document.querySelectorAll('#article .card-grip').length, 0, '锁定空间不应提供拖动手柄');
    assert.equal(document.querySelectorAll('#page-list .tree-grip').length, 0, '锁定空间的侧栏行不应提供拖动手柄');
    const row = document.querySelector('#page-list .tree-row .page-item')!;
    pointer(window, 'pointerdown', 40, 12, row);
    pointer(window, 'pointermove', 40, 200, window);
    pointer(window, 'pointerup', 40, 200, window);
    assert.equal(puts.length, 0, '锁定空间不应允许拖动排序');
    assert.equal(document.querySelector('#page-list .tree-drop'), null, '锁定空间拖动不应显示插入线');
  }

  /* ---- Style guards: the grip, lifted card and dashed placeholder must exist. ---- */
  {
    const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    };
    assert.match(rule('.card-grip'), /position:\s*absolute/, '拖动手柄应固定在卡片角上');
    assert.match(rule('.card-grip'), /touch-action:\s*none/, '触摸拖动时不应触发滚动');
    assert.match(rule('body.is-card-dragging .article'), /animation:\s*none/, '拖动时文章入场动画不能改变固定定位参照');
    assert.match(rule('body.is-card-dragging .article'), /transform:\s*none\s*!important/, '拖动时文章不得建立固定定位包含块');
    assert.match(rule('.card.is-dragging'), /position:\s*fixed/, '拖动中的卡片应脱离文档流跟随指针');
    assert.match(rule('.card.is-dragging'), /box-shadow:\s*var\(--shadow-lg\)/, '拖动中的卡片应有抬起阴影');
    assert.match(rule('.card-placeholder'), /border:\s*1.5px dashed/, '放置位应使用虚线占位');
    assert.match(rule('.tree-drop'), /height:\s*2px/, '插入指示应为一条细线');
    assert.match(rule('.tree-drop'), /background:\s*var\(--accent\)/, '插入线应使用强调色');
    assert.match(rule('.tree-drop'), /position:\s*absolute/, '插入线应悬浮覆盖，不占据布局');
    assert.doesNotMatch(rule('.tree-drop'), /transition\s*:/, '插入线不得因位置过渡落后于实际拖拽目标');
    assert.match(rule('.tree-drop::before'), /width:\s*18px/, '插入线左端应有圆形拖动标记');
    assert.match(rule('.tree-drop::before'), /border:\s*2px solid var\(--accent\)/, '圆形标记应有描边');
    assert.match(rule('.tree-row.is-drop-target'), /background:\s*var\(--bg-hover\)/, '目标行应高亮');
    assert.match(rule('.tree-grip'), /position:\s*absolute/, '侧栏手柄应固定在行左侧');
    assert.match(rule('.tree-grip'), /touch-action:\s*none/, '侧栏手柄应吞掉触摸滚动，避免与抽屉滚动打架');
    assert.match(rule('.tree-row:hover .tree-grip, .tree-row:focus-within .tree-grip'), /opacity:\s*1/, '桌面端悬停时显示手柄');
    assert.ok(css.includes('@media (hover: none) { .tree-grip { opacity: 1; } }'), '触摸屏没有 hover，手柄应常显');
    assert.match(rule('.tree-drag-ghost'), /position:\s*fixed/, '拖动时应跟随指针显示幽灵标签');
  }

  console.log('space manual order assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
