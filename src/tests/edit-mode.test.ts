/*
 * Visual ⇄ Markdown editing hot-switch.
 *
 * Both surfaces describe one Markdown document. Switching must carry the in-progress edits
 * across — serialising the visual DOM or reading the textarea raw — so nothing typed is lost
 * and the save payload is always Markdown. These regressions are exactly what a naive toggle
 * (re-seeding from the stored page, or reading the wrong element) would break.
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
const dom = new JSDOM(html, { url: 'http://localhost:4173/default/welcome', pretendToBeVisual: true, runScripts: 'outside-only' });
const window = dom.window as unknown as any;
const document = window.document as Document;

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'localStorage', {
  value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
  configurable: true,
});
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};
window.navigator.clipboard = { writeText: async () => {} };

const STORED = '# 标题\n\n正文 **粗体** 文本。';

// Record the body of every PUT so we can assert on the save payload.
const puts: Array<Record<string, unknown>> = [];
window.fetch = async (url: string, opts: any = {}) => {
  if (url.includes('/api/auth/state')) return { ok: true, json: async () => ({ mode: 'ready', authed: true, user: 'tester', salt: '00', iters: 1 }) };
  if (url.includes('/api/tree')) {
    return { ok: true, json: async () => ({
      spaces: [{ slug: 'default', title: '空间', desc: '', home: 'welcome', createdAt: Date.now(), updatedAt: Date.now() }],
      pages: [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎', createdAt: Date.now(), updatedAt: Date.now() }],
    }) };
  }
  if (opts.method === 'PUT') {
    const body = JSON.parse(opts.body);
    puts.push(body);
    return { ok: true, json: async () => ({ slug: 'welcome', space: 'default', parent: null, title: body.title, content: body.content, createdAt: Date.now(), updatedAt: Date.now() }) };
  }
  return { ok: true, json: async () => ({
    slug: 'welcome', space: 'default', parent: null, title: '欢迎',
    content: STORED, createdAt: Date.now(), updatedAt: Date.now(),
  }) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const visible = (selector: string) => !$(selector).hasAttribute('hidden');

async function main(): Promise<void> {
  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(80);

  /* ---- Open the editor: the visual surface is active and shows rendered Markdown ---- */
  click('#btn-edit');
  await wait(30);
  assert.equal(visible('#editor'), true, '可视化编辑区应可见');
  assert.equal(visible('#source-editor'), false, '源码编辑区初始应隐藏');
  assert.match($('#editor').innerHTML, /<h1[^>]*>标题<\/h1>/, '存储的 Markdown 应被渲染进可视化编辑器');

  /* ---- Visual → Markdown: the edit made in the WYSIWYG surface must be serialised ---- */
  $('#editor').innerHTML = '<h2>改过的标题</h2><p>新增段落</p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  assert.equal(visible('#source-editor'), true, '切换后源码编辑区应可见');
  assert.equal(visible('#editor'), false, '切换后可视化编辑区应隐藏');
  assert.equal(visible('#toolbar-wrap'), false, 'Markdown 模式下格式化工具栏应隐藏');
  const md = ($('#source-editor') as HTMLTextAreaElement).value;
  assert.match(md, /## 改过的标题/, '可视化编辑的改动应序列化为 Markdown');
  assert.match(md, /新增段落/, '新增段落应进入 Markdown');
  assert.equal($('#dirty-pill').hidden, false, '切换不应清除未保存标记');

  /* ---- Markdown → Visual: raw edits must be rendered back into the WYSIWYG surface ---- */
  const ta = $('#source-editor') as HTMLTextAreaElement;
  ta.value = '# 源码标题\n\n- 甲\n- 乙';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#mode-toggle [data-mode="visual"]');
  await wait(30);
  assert.equal(visible('#editor'), true, '切换回可视化后编辑区应可见');
  assert.equal(visible('#source-editor'), false, '切换回可视化后源码区应隐藏');
  assert.equal(visible('#toolbar-wrap'), true, '可视化模式应恢复工具栏');
  assert.match($('#editor').innerHTML, /<h1[^>]*>源码标题<\/h1>/, 'Markdown 源码应被渲染');
  assert.equal($('#editor').querySelectorAll('li').length, 2, '列表应渲染为两个条目');

  /* ---- Saving from the Markdown surface sends Markdown verbatim ---- */
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  ta.value = '# 最终标题\n\n最终正文。';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#btn-save');
  await wait(60);
  assert.equal(puts.length, 1, '保存应发出一次 PUT');
  assert.equal(puts[0].content, '# 最终标题\n\n最终正文。', 'Markdown 模式下保存应原样提交');

  /* ---- Saving from the visual surface still sends Markdown ---- */
  click('#btn-edit');
  await wait(30);
  $('#editor').innerHTML = '<p>可视化 <b>加粗</b></p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#btn-save');
  await wait(60);
  assert.equal(puts.length, 2, '第二次保存应再发出一次 PUT');
  assert.equal(puts[1].content, '可视化 **加粗**', '可视化模式保存应序列化为 Markdown');

  console.log('edit mode assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
