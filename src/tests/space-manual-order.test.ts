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

async function boot(url: string, locked = false, extraPages: any[] = []): Promise<Harness> {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window as any;
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

  /* ---- Nested cards expand independently and keep sibling drag ordering. ---- */
  {
    const { window, document, puts } = await boot('http://localhost:4173/default', false, [
      { slug: 'alpha_one', space: 'default', parent: 'alpha', title: '子一', createdAt: 2, updatedAt: 2 },
      { slug: 'alpha_two', space: 'default', parent: 'alpha', title: '子二', createdAt: 1, updatedAt: 1 },
      { slug: 'alpha_grand', space: 'default', parent: 'alpha_one', title: '孙页', createdAt: 1, updatedAt: 1 },
    ]);
    await wait(120);
    const card = (slug: string) => document.querySelector<HTMLElement>(`.space-page-card[data-slug="${slug}"]`);
    const toggle = (slug: string) => card(slug)!.querySelector<HTMLButtonElement>(':scope > .card-expand')!;
    assert.equal(toggle('alpha').getAttribute('aria-expanded'), 'false', '子页面默认折叠');
    assert.equal(card('alpha_one'), null, '折叠时不渲染子卡片');
    toggle('alpha').click();
    assert.equal(toggle('alpha').getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, toggle('alpha'), '重新渲染后保留键盘焦点');
    assert.ok(card('alpha_one') && card('alpha_two'), '展开后显示直接子页面');
    assert.equal(card('alpha_grand'), null, '孙页面仍默认折叠');
    toggle('alpha_one').click();
    assert.ok(card('alpha_grand'), '支持逐层展开');
    toggle('alpha').click();
    assert.equal(card('alpha_one'), null, '折叠父页面隐藏整个子树');
    toggle('alpha').click();
    assert.ok(card('alpha_grand'), '重新展开时保留后代展开状态');
    assert.equal(puts.length, 0, '展开和折叠不得修改页面或顺序');

    // Reorder the two children only; the first child's expanded subtree follows it.
    layoutCards(document);
    const first = card('alpha_one')!;
    pointer(window, 'pointerdown', 30, 140, first.querySelector(':scope > .card-grip')!);
    pointer(window, 'pointermove', 300, 500, window);
    pointer(window, 'pointerup', 300, 500, window);
    await wait(160);
    assert.deepEqual(puts[0].body, { sort: 'manual', order: ['alpha', 'alpha_two', 'alpha_one', 'alpha_grand', 'beta', 'gamma'] }, '子卡片拖动只排序同级并保留完整子树');
    assert.equal(toggle('alpha').getAttribute('aria-expanded'), 'true', '排序后保持展开状态');
    assert.ok(card('alpha_grand'), '排序后保持后代展开状态');
    layoutCards(document);
    const parent = card('alpha')!;
    pointer(window, 'pointerdown', 30, 20, parent.querySelector(':scope > .card-grip')!);
    pointer(window, 'pointermove', 300, 1000, window);
    pointer(window, 'pointerup', 300, 1000, window);
    await wait(160);
    assert.deepEqual(puts[1].body, { order: ['beta', 'gamma', 'alpha', 'alpha_two', 'alpha_one', 'alpha_grand'] }, '展开时拖动父卡片仍只排序顶层并保留子树');
    card('alpha_two')!.querySelector<HTMLAnchorElement>(':scope > .card-link')!.click();
    await wait(120);
    assert.equal(document.title, '子二 · DocLight', '点击子卡片主体打开对应页面');
    window.close();
  }

  /* ---- Read-only spaces still expose expansion but never sorting. ---- */
  {
    const { window, document } = await boot('http://localhost:4173/default', true, [
      { slug: 'locked_child', space: 'default', parent: 'alpha', title: '只读子页', createdAt: 1, updatedAt: 1 },
    ]);
    await wait(120);
    document.querySelector<HTMLButtonElement>('.space-page-card[data-slug="alpha"] > .card-expand')!.click();
    assert.ok(document.querySelector('.space-page-card[data-slug="locked_child"] > .card-link'), '只读空间也可展开子页面');
    assert.equal(document.querySelectorAll('#article .card-grip').length, 0, '只读空间的子页面也不能拖动');
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
    assert.match(rule('.card.is-dragging'), /position:\s*fixed/, '拖动中的卡片应脱离文档流跟随指针');
    assert.match(rule('.card.is-dragging'), /box-shadow:\s*var\(--shadow-lg\)/, '拖动中的卡片应有抬起阴影');
    assert.match(rule('.card-placeholder'), /border:\s*1.5px dashed/, '放置位应使用虚线占位');
    assert.match(rule('.tree-drop'), /height:\s*2px/, '插入指示应为一条细线');
    assert.match(rule('.tree-drop'), /background:\s*var\(--accent\)/, '插入线应使用强调色');
    assert.match(rule('.tree-drop'), /position:\s*absolute/, '插入线应悬浮覆盖，不占据布局');
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
