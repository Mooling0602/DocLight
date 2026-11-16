/* Reverse-proxy mount paths must apply to routing, links, and API calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const publicDir = path.resolve(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const bundle = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 60));
const space = { slug: 'doclight-default', title: 'Docs', desc: '', home: null, createdAt: 1, updatedAt: 1 };
const page = { slug: 'doclight-default-guide', space: space.slug, parent: null, title: 'Guide', createdAt: 1, updatedAt: 1 };
const child = { slug: 'child', space: space.slug, parent: page.slug, title: 'Child', createdAt: 1, updatedAt: 1 };

async function boot(base: string | null, pathname: string) {
  const meta = base === null ? '' : `<meta name="doclight-base-path" content="${base}">`;
  const dom = new JSDOM(html.replace('</head>', `${meta}</head>`), { url: 'http://localhost:4173' + pathname, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.scrollTo = function () {};
  w.Element.prototype.scrollIntoView = function () {};
  const calls: string[] = [];
  w.fetch = async (input: string) => {
    const url = String(input); calls.push(url);
    const data = url.endsWith('/auth/state') ? { mode: 'ready', authed: false, user: null, salt: '', iters: 1 }
      : url.endsWith('/tree') ? { spaces: [space], pages: [page, child] }
      : url.endsWith('/pages/child') ? { ...child, content: '# Child\n\n[Guide](/doclight-default/doclight-default-guide)' }
      : { ...page, content: '[Guide](/doclight-default/doclight-default-guide) [Asset](/files/image.png) [Outside](https://example.com/) [Section](#part)' };
    return { ok: true, status: 200, json: async () => data };
  };
  w.eval(bundle);
  await wait();
  return { dom, w, d: w.document as Document, calls };
}
function click(w: any, d: Document, selector: string) {
  const el = d.querySelector(selector); assert.ok(el, selector);
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}
async function main() {
  const prefixed = await boot('/editor/', '/editor/doclight-default/doclight-default-guide/child');
  try {
    const { w, d, calls } = prefixed;
    assert.ok(calls.includes('/editor/api/tree'));
    assert.ok(calls.includes('/editor/api/auth/state'));
    assert.ok(calls.includes('/editor/api/pages/child'));
    assert.match(d.querySelector('#article')!.textContent!, /Child/);
    assert.equal(d.querySelector('.brand')!.getAttribute('href'), '/editor/');
    assert.equal(d.querySelector('.space-title')!.getAttribute('href'), '/editor/doclight-default');
    assert.equal(d.querySelector('.page-item')!.getAttribute('href'), '/editor/doclight-default/doclight-default-guide');
    assert.equal(d.querySelector('.crumbs a')!.getAttribute('href'), '/editor/doclight-default');
    click(w, d, '#article a[data-nav][href="/editor/doclight-default/doclight-default-guide"]'); await wait();
    assert.equal(w.location.pathname, '/editor/doclight-default/doclight-default-guide');
    const links = [...d.querySelectorAll('#article a')];
    assert.equal(links.find(a => a.textContent === 'Guide')!.getAttribute('href'), '/editor/doclight-default/doclight-default-guide');
    assert.equal(links.find(a => a.textContent === 'Asset')!.getAttribute('href'), '/files/image.png');
    assert.equal(links.find(a => a.textContent === 'Outside')!.getAttribute('href'), 'https://example.com/');
    assert.equal(links.find(a => a.textContent === 'Section')!.getAttribute('href'), '#part');
    click(w, d, '.brand'); await wait();
    assert.equal(w.location.pathname, '/editor/');
    assert.equal(d.querySelector('.card')!.getAttribute('href'), '/editor/doclight-default');
    w.history.back(); await wait();
    assert.equal(w.location.pathname, '/editor/doclight-default/doclight-default-guide');
    assert.match(d.querySelector('#article')!.textContent!, /Guide/);
    const search = d.querySelector('#search') as HTMLInputElement;
    search.value = 'Child'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(d.querySelector('.page-item')!.getAttribute('href'), '/editor/doclight-default/doclight-default-guide/child');
  } finally { prefixed.dom.window.close(); }
  for (const base of [null, '']) {
    const root = await boot(base, '/doclight-default/doclight-default-guide');
    try {
      assert.ok(root.calls.includes('/api/tree'));
      assert.equal(root.d.querySelector('.brand')!.getAttribute('href'), '/');
      assert.equal(root.d.querySelector('.page-item')!.getAttribute('href'), '/doclight-default/doclight-default-guide');
      click(root.w, root.d, '.brand'); await wait();
      assert.equal(root.w.location.pathname, '/');
    } finally { root.dom.window.close(); }
  }
  const boundary = await boot('/editor', '/editorial/doclight-default');
  try { assert.equal(boundary.w.location.pathname, '/editor/'); } finally { boundary.dom.window.close(); }
  const legacy = await boot('/editor', '/editor/doclight-default-guide');
  try { assert.equal(legacy.w.location.pathname, '/editor/doclight-default/doclight-default-guide'); } finally { legacy.dom.window.close(); }
  console.log('base path UI tests passed');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
