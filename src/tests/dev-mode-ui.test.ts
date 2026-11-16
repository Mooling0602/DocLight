/* Developer mode exposes built-in space and page management without changing ordinary locks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const bundle = buildSync({ entryPoints: [path.join(root, 'src/client/app.ts')], bundle: true, write: false, platform: 'browser', format: 'iife' }).outputFiles[0].text;
const base = { title: '空间', desc: '', home: null, createdAt: 1, updatedAt: 1, locked: true };
const page = { slug: 'guide', space: 'docs', parent: null, title: '原始标题', createdAt: 1, updatedAt: 1 };
const wait = () => new Promise(resolve => setTimeout(resolve, 80));

async function boot(space: Record<string, unknown>, authed = true, pathname = '/docs/guide', pages: Array<Omit<typeof page, 'parent'> & { parent: string | null }> = [page]) {
  const dom = new JSDOM(html, { url: 'http://localhost:4173' + pathname, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window as any;
  const d = w.document as Document;
  const calls: { url: string; method: string; body: any }[] = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.Element.prototype.scrollTo = function () {};
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = async (input: string, opts: any = {}) => {
    const url = String(input), method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    const data = url.endsWith('/auth/state') ? { mode: 'ready', authed, user: authed ? 'admin' : null, salt: '', iters: 1 }
      : url.endsWith('/tree') ? { spaces: [{ ...base, slug: 'docs', ...space }], pages: pages.map(p => ({ ...p })) }
      : method === 'PUT' ? { ...page, ...body }
      : method === 'DELETE' && url.includes('/spaces/') ? { ok: true, removedSpace: 'docs', removedPages: pages.map(p => p.slug) }
      : { ...(pages.find(p => url.endsWith('/pages/' + encodeURIComponent(p.slug))) || page), content: '# 原始内容' };
    return { ok: true, status: 200, json: async () => data };
  };
  w.eval(bundle);
  await wait();
  const get = <T extends Element = HTMLElement>(selector: string): T => {
    const el = d.querySelector<T>(selector); assert.ok(el, selector); return el;
  };
  const click = (selector: string) => get(selector).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { dom, w, d, calls, get, click };
}

async function main() {
  const off = await boot({ builtIn: true });
  try {
    assert.equal(off.get('#cluster-view').hidden, true);
    assert.equal(off.get('#btn-edit').hidden, true);
    assert.match(off.get('#article').textContent || '', /永久只读/);
    off.click('#btn-edit');
    assert.equal(off.get('#edit-wrap').hidden, true, 'locked built-in pages cannot enter edit mode');
  } finally { off.dom.window.close(); }

  const on = await boot({ builtIn: true, devEditable: true });
  try {
    const { d, w, get, click, calls } = on;
    assert.equal(get('#cluster-view').hidden, false);
    assert.equal(get('#btn-edit').hidden, false);
    assert.equal(get('#btn-more').hidden, false);
    assert.ok(d.querySelector('#slug-edit'), 'the slug is editable in developer mode');
    assert.equal(get<HTMLElement>('#menu-page [data-act="slug"]').hidden, false);
    assert.match(get('#article').textContent || '', /开发者模式.*模板源码/);
    assert.doesNotMatch(get('#article').textContent || '', /永久只读/);
    assert.doesNotMatch(get('#page-list').textContent || '', /永久只读/);
    assert.ok(d.querySelector('.space-row [title="空间管理"]'));
    assert.ok(d.querySelector('.space-row [title="在此空间新建页面"]'));
    assert.ok(d.querySelector('.tree-row [title="新建子页面"]'));
    assert.ok(d.querySelector('.tree-row [title="更多操作"]'));
    click('#btn-edit');
    assert.equal(get('#edit-wrap').hidden, false);
    assert.equal(get('#cluster-edit .editor-lock-badge').textContent, '开发者模式');
    click('#mode-toggle [data-mode=markdown]');
    const title = get<HTMLInputElement>('#title-input');
    const source = get<HTMLTextAreaElement>('#source-editor');
    title.value = '新标题'; title.dispatchEvent(new w.Event('input', { bubbles: true }));
    source.value = '# 新内容\n\n原样保存'; source.dispatchEvent(new w.Event('input', { bubbles: true }));
    click('#btn-save'); await wait();
    assert.deepEqual(calls.filter(c => c.method === 'PUT'), [{ url: '/api/pages/guide', method: 'PUT', body: { title: '新标题', content: '# 新内容\n\n原样保存' } }]);
    assert.equal(get('#edit-wrap').hidden, true);
    click('.space-title'); await wait();
    assert.equal(get<HTMLElement>('.space-acts').hidden, false);
    assert.ok(d.querySelector('#sp-slug-edit'));
    assert.doesNotMatch(get('#article').textContent || '', /永久只读/);
    click('.brand'); await wait();
    assert.doesNotMatch(get('#article').textContent || '', /永久只读/);
  } finally { on.dom.window.close(); }

  const home = await boot({ builtIn: true, devEditable: true, home: 'guide' }, true, '/docs');
  try {
    assert.equal(home.get<HTMLElement>('.space-acts').hidden, false, 'developer space home opens the full index');
    assert.ok(home.d.querySelector('#sp-add'));
    assert.ok(home.d.querySelector('#sp-sort'));
    assert.ok(home.d.querySelector('#sp-delete'), 'the built-in space is deletable in developer mode');
    home.click('.tree-row [title="更多操作"]');
    assert.ok(home.d.querySelector('#menu-row [data-act=slug]'), 'page slugs are editable in developer mode');
    home.click('#menu-row [data-act=delete]');
    assert.match(home.get('#modal-root').textContent || '', /模板源码/);
    home.click('#modal-root [data-x=no]');
    assert.equal(home.calls.filter(c => c.method === 'DELETE').length, 0);
    home.click('.tree-row [title="更多操作"]');
    home.click('#menu-row [data-act=move]');
    assert.match(home.get('#modal-root').textContent || '', /只能放在顶层/);
    assert.ok(home.get<HTMLSelectElement>('#move-select').options.length);
    home.click('#modal-root [data-x=no]');
  } finally { home.dom.window.close(); }

  const leaf = await boot({ builtIn: true, devEditable: true }, true, '/docs');
  try {
    leaf.click('.tree-row [title="更多操作"]');
    leaf.click('#menu-row [data-act=delete]');
    assert.match(leaf.get('#modal-root').textContent || '', /删除「原始标题」/);
    assert.equal(leaf.calls.filter(c => c.method === 'DELETE').length, 0, 'deletion requires confirmation');
    leaf.click('#modal-root [data-x=no]'); await wait();
    assert.equal(leaf.calls.filter(c => c.method === 'DELETE').length, 0);
    leaf.click('.tree-row [title="更多操作"]');
    leaf.click('#menu-row [data-act=delete]');
    leaf.click('#modal-root [data-x=ok]'); await wait();
    assert.deepEqual(leaf.calls.filter(c => c.method === 'DELETE'), [{ url: '/api/pages/guide', method: 'DELETE', body: undefined }]);
  } finally { leaf.dom.window.close(); }

  const other = { ...page, slug: 'other', title: '目标页面' };
  const moving = await boot({ builtIn: true, devEditable: true }, true, '/docs/guide', [page, other]);
  try {
    moving.click('#btn-more');
    moving.click('#menu-page [data-act=move]');
    const select = moving.get<HTMLSelectElement>('#move-select');
    select.value = 'p:other';
    moving.click('#modal-root [data-x=ok]'); await wait();
    assert.deepEqual(moving.calls.filter(c => c.method === 'PUT'), [
      { url: '/api/pages/guide', method: 'PUT', body: { parent: 'other' } },
    ]);
  } finally { moving.dom.window.close(); }

  const rootPage = { ...page, slug: 'doclight-default-guide' };
  const child = { ...page, slug: 'doclight-default-child', parent: 'doclight-default-guide', title: '子页面' };
  const spaceSlug = await boot({ builtIn: true, devEditable: true, home: 'doclight-default-guide' }, true, '/docs', [rootPage, child]);
  try {
    const originalFetch = spaceSlug.w.fetch;
    spaceSlug.w.fetch = async (input: string, opts: any = {}) => {
      if (String(input) === '/api/spaces/docs' && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        spaceSlug.calls.push({ url: String(input), method: opts.method, body });
        return { ok: true, status: 200, json: async () => ({ ...base, slug: 'renamed', builtIn: true, devEditable: true, home: 'doclight-default-guide' }) };
      }
      return originalFetch(input, opts);
    };
    spaceSlug.click('#sp-slug-edit');
    assert.match(spaceSlug.get('#modal-root').textContent || '', /旧空间链接及 Markdown 中硬编码的旧链接将失效/);
    spaceSlug.get<HTMLInputElement>('#modal-root input').value = 'renamed';
    spaceSlug.click('#modal-root [data-x=ok]'); await wait();
    assert.deepEqual(spaceSlug.calls.filter(c => c.method === 'PUT'), [{ url: '/api/spaces/docs', method: 'PUT', body: { slug: 'renamed' } }]);
    assert.equal(spaceSlug.w.location.pathname, '/renamed');
    assert.equal(spaceSlug.get<HTMLAnchorElement>('.tree-row .page-item').getAttribute('href'), '/renamed/doclight-default-guide');
  } finally { spaceSlug.dom.window.close(); }

  const subtree = await boot({ builtIn: true, devEditable: true, home: 'doclight-default-child' }, true, '/docs', [rootPage, child]);
  try {
    subtree.click('.tree-row [title="更多操作"]');
    subtree.click('#menu-row [data-act=delete]');
    assert.match(subtree.get('#modal-root').textContent || '', /1 个子页面/);
    assert.match(subtree.get('#modal-root').textContent || '', /模板源码/);
    assert.equal(subtree.calls.filter(c => c.method === 'DELETE').length, 0, 'deletion requires confirmation');
    subtree.click('#modal-root [data-x=ok]'); await wait();
    assert.deepEqual(subtree.calls.filter(c => c.method === 'DELETE'), [
      { url: '/api/pages/doclight-default-guide', method: 'DELETE', body: undefined },
    ]);
  } finally { subtree.dom.window.close(); }

  const regularHome = await boot({ builtIn: true, home: 'guide' }, true, '/docs');
  try {
    assert.equal(regularHome.d.querySelector('.space-acts'), null, 'ordinary home routing stays unchanged');
    assert.match(regularHome.get('#article').textContent || '', /原始内容/);
  } finally { regularHome.dom.window.close(); }

  const unauth = await boot({ builtIn: true, devEditable: true }, false);
  try {
    unauth.click('#btn-edit');
    assert.equal(unauth.get('#modal-root').hidden, false, 'editing requires authentication');
    assert.equal(unauth.get('#edit-wrap').hidden, true);
    assert.equal(unauth.calls.filter(c => c.method === 'PUT').length, 0);
  } finally { unauth.dom.window.close(); }

  const ordinary = await boot({ devEditable: true });
  try {
    assert.equal(ordinary.get('#btn-edit').hidden, true, 'devEditable alone cannot bypass ordinary locks');
    assert.equal(ordinary.get('#cluster-view').hidden, true);
    assert.match(ordinary.get('#article').textContent || '', /空间已锁定，只读/);
    ordinary.click('#btn-edit');
    assert.equal(ordinary.get('#edit-wrap').hidden, true);
    assert.equal(ordinary.calls.filter(c => c.method === 'PUT').length, 0);
  } finally { ordinary.dom.window.close(); }
  console.log('developer mode UI assertions passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
