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
import { Text } from '@codemirror/state';
import { SourceDraft } from '../client/source-draft.js';
import { setSource, sourceView } from './source-editor-utils.js';

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

const STORED = '#   标题\n\n正文 __粗体__ 文本。';

// Record the body of every PUT so we can assert on the save payload.
const puts: Array<Record<string, unknown>> = [];
let unclosedFrontMatter = false;
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
    content: unclosedFrontMatter ? '---\ntitle: 未闭合' : STORED,
    ...(unclosedFrontMatter ? { unclosedFrontMatter: true } : {}), createdAt: Date.now(), updatedAt: Date.now(),
  }) };
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const visible = (selector: string) => !$(selector).hasAttribute('hidden');

async function main(): Promise<void> {
  // The immutable draft survives a missing view, including a deliberate empty document.
  const retained = new SourceDraft();
  assert.equal(retained.read('fallback'), 'fallback');
  retained.update(Text.of(['新稿', '', '尾行']));
  assert.equal(retained.read('旧稿'), '新稿\n\n尾行', '丢失视图时必须使用最近一次文档');
  retained.update(Text.of(['']));
  assert.equal(retained.read('旧稿'), '', '空文档也是有效草稿，不能回退');
  retained.clear();
  assert.equal(retained.read('新页面'), '新页面', '清除后不得泄漏上一个页面的草稿');

  window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
  await wait(80);

  /* ---- Open the editor: the visual surface is active and shows rendered Markdown ---- */
  click('#btn-edit');
  await wait(30);
  assert.equal(visible('#editor'), true, '可视化编辑区应可见');
  assert.equal(visible('#source-panel'), false, '源码编辑区初始应隐藏');
  assert.match($('#editor').innerHTML, /<h1[^>]*>标题<\/h1>/, '存储的 Markdown 应被渲染进可视化编辑器');
  // The active mode must be exposed to assistive tech, not only via an `is-on` class.
  assert.equal($('#mode-toggle [data-mode="visual"]').getAttribute('aria-pressed'), 'true', '可视化按钮应标记为选中');
  assert.equal($('#mode-toggle [data-mode="markdown"]').getAttribute('aria-pressed'), 'false', 'Markdown 按钮应标记为未选中');
  // The hint is rewritten on every switch, so its <kbd> chips must survive: assigning
  // textContent instead of innerHTML would silently drop them (and their styling).
  assert.equal($('#edit-hint').querySelectorAll('kbd').length, 2, '可视化模式提示应保留 kbd 按键标记');

  // An untouched visual surface must not normalise the stored source on first switch.
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  assert.equal(sourceView(document).state.doc.toString(), STORED, '首次进入源码模式应保留原始正文');
  assert.ok(document.querySelector('.cm-lineNumbers'), '源码模式应显示行号');
  assert.ok(document.querySelector('.cm-line span'), 'Markdown 标记应有语法高亮');
  assert.equal(sourceView(document).contentDOM.getAttribute('aria-label'), 'Markdown 源码编辑区');
  assert.equal($('#source-wrap-toggle').getAttribute('aria-pressed'), 'true', '自动换行默认开启');
  assert.ok(sourceView(document).contentDOM.classList.contains('cm-lineWrapping'));
  sourceView(document).dispatch({ selection: { anchor: 2 } });
  click('#source-wrap-toggle');
  assert.equal($('#source-wrap-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(window.localStorage.getItem('doclight-markdown-wrap'), 'off', '换行偏好应持久保存');
  assert.equal(sourceView(document).contentDOM.classList.contains('cm-lineWrapping'), false);
  assert.equal(sourceView(document).state.selection.main.head, 2, '切换换行设置应保留光标');
  assert.equal($('#dirty-pill').hidden, true, '切换换行设置不能修改文档');
  click('#mode-toggle [data-mode="visual"]');
  await wait(20);
  const titleInput = $('#title-input') as HTMLInputElement;
  titleInput.value = '只改标题';
  titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#btn-save');
  await wait(60);
  assert.equal(puts[0].content, STORED, '只修改标题不得规范化或改写正文');
  click('#btn-edit');
  await wait(30);

  /* ---- Visual → Markdown: the edit made in the WYSIWYG surface must be serialised ---- */
  $('#editor').innerHTML = '<h2>改过的标题</h2><p>新增段落</p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  assert.equal(visible('#source-panel'), true, '切换后源码编辑区应可见');
  assert.equal(visible('#editor'), false, '切换后可视化编辑区应隐藏');
  assert.equal(visible('#toolbar-wrap'), false, 'Markdown 模式下格式化工具栏应隐藏');
  const md = sourceView(document).state.doc.toString();
  assert.match(md, /## 改过的标题/, '可视化编辑的改动应序列化为 Markdown');
  assert.match(md, /新增段落/, '新增段落应进入 Markdown');
  assert.equal($('#dirty-pill').hidden, false, '切换不应清除未保存标记');
  assert.equal($('#mode-toggle [data-mode="markdown"]').getAttribute('aria-pressed'), 'true', '切换后按钮选中态应同步');
  assert.equal($('#edit-hint').querySelectorAll('kbd').length, 3, 'Markdown 模式提示也应保留 kbd 按键标记');

  /* ---- Markdown → Visual: raw edits must be rendered back into the WYSIWYG surface ---- */
  setSource(document, '# 源码标题\n\n- 甲\n- 乙');
  const keptView = sourceView(document);
  await wait(550);
  keptView.dispatch({ changes: { from: keptView.state.doc.length, insert: '\n\n可撤销' }, userEvent: 'input.type' });
  click('#mode-toggle [data-mode="visual"]');
  await wait(30);
  assert.equal(visible('#editor'), true, '切换回可视化后编辑区应可见');
  assert.equal(visible('#source-panel'), false, '切换回可视化后源码区应隐藏');
  assert.equal(visible('#toolbar-wrap'), true, '可视化模式应恢复工具栏');
  assert.match($('#editor').innerHTML, /<h1[^>]*>源码标题<\/h1>/, 'Markdown 源码应被渲染');
  assert.equal($('#editor').querySelectorAll('li').length, 2, '列表应渲染为两个条目');

  /* ---- Saving from the Markdown surface sends Markdown verbatim ---- */
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  assert.equal(sourceView(document), keptView, '可视化正文未改动时应保留源码编辑器及撤销历史');
  assert.equal($('#source-wrap-toggle').getAttribute('aria-pressed'), 'false', '切换模式后应保留换行偏好');
  keptView.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(keptView.state.doc.toString(), '# 源码标题\n\n- 甲\n- 乙', '模式切换后撤销仍可恢复最近一次源码编辑');
  setSource(document, '');
  click('#mode-toggle [data-mode="visual"]');
  click('#mode-toggle [data-mode="markdown"]');
  assert.equal(sourceView(document).state.doc.toString(), '', '清空正文并切换模式不得恢复旧草稿');
  setSource(document, '---\n\n# 最终标题\n\n最终正文。');
  sourceView(document).contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await wait(60);
  assert.equal(puts.length, 2, '保存应再发出一次 PUT');
  assert.equal(puts[1].content, '---\n\n# 最终标题\n\n最终正文。', 'Markdown 正文开头的水平分隔线不能当作元数据删除');

  /* ---- Tab indents whole lines, never replacing a multi-line selection ---- */
  click('#btn-edit');
  await wait(30);
  click('#mode-toggle [data-mode="markdown"]');
  await wait(20);
  setSource(document, '第一行\n第二行\n第三行');
  const view = sourceView(document);
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  const tab = () => view.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  const shiftTab = () => view.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));

  tab();
  assert.equal(view.state.doc.toString(), '  第一行\n  第二行\n  第三行', '多行选区应逐行缩进而非被替换');
  assert.equal(view.state.selection.main.from, 2, '缩进后选区应保留原始文字');
  assert.equal(view.state.selection.main.to, view.state.doc.length, '整段选区缩进后应仍覆盖整段');

  shiftTab();
  assert.equal(view.state.doc.toString(), '第一行\n第二行\n第三行', 'Shift+Tab 应逐行减少缩进');

  // A bare caret indents the current line without deleting other content.
  setSource(document, '甲\n乙');
  view.dispatch({ selection: { anchor: 1 } });
  tab();
  assert.equal(view.state.doc.toString(), '  甲\n乙', '无选区时应只缩进光标所在行');

  setSource(document, '无缩进');
  view.dispatch({ selection: { anchor: 0 } });
  shiftTab();
  assert.equal(view.state.doc.toString(), '无缩进', '无缩进可去掉时 Shift+Tab 不应改动内容');

  /* ---- Saving from the visual surface still sends Markdown ---- */
  click('#mode-toggle [data-mode="visual"]');
  await wait(30);
  $('#editor').innerHTML = '<p>可视化 <b>加粗</b></p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  click('#btn-save');
  await wait(60);
  assert.equal(puts.length, 3, '可视化保存应再发出一次 PUT');
  assert.equal(puts[2].content, '可视化 **加粗**', '可视化模式保存应序列化为 Markdown');

  // A hidden, stale source view must never overwrite a later visual draft.
  click('#btn-edit');
  click('#mode-toggle [data-mode="markdown"]');
  setSource(document, '旧源码');
  const hiddenView = sourceView(document);
  click('#mode-toggle [data-mode="visual"]');
  $('#editor').innerHTML = '<p>新的可视化内容</p>';
  $('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
  hiddenView.dispatch({ changes: { from: hiddenView.state.doc.length, insert: '迟到事件' } });
  click('#mode-toggle [data-mode="markdown"]');
  assert.equal(sourceView(document).state.doc.toString(), '新的可视化内容', '隐藏的旧视图不得覆盖可视化草稿');
  click('#btn-save');
  await wait(60);
  assert.equal(puts[3].content, '新的可视化内容');

  // Opening the link prompt steals focus and may discard the browser's selection.
  click('#btn-edit');
  const editor = $('#editor');
  editor.innerHTML = '<p>选中的文字</p>';
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor.querySelector('p')!);
  selection.removeAllRanges();
  selection.addRange(range);
  let commandUrl = '';
  (document as any).execCommand = (command: string, _ui: boolean, value: string) => {
    assert.equal(document.activeElement, editor, '执行链接命令时焦点应回到编辑区');
    assert.equal(selection.toString(), '选中的文字', '执行链接命令时应恢复弹窗前的选区');
    assert.equal(command, 'createLink');
    commandUrl = value;
    const selected = selection.getRangeAt(0);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', value);
    anchor.appendChild(selected.extractContents());
    selected.insertNode(anchor);
    return true;
  };
  click('#toolbar [data-cmd="createlink"]');
  selection.removeAllRanges(); // Simulate the selection being lost to the modal input.
  const linkInput = $('#modal-root input') as HTMLInputElement;
  linkInput.value = 'https://example.com/?a=1&b=2';
  click('#modal-root [data-x="ok"]');
  await wait(20);
  assert.equal(commandUrl, 'https://example.com/?a=1&b=2', '浏览器命令应接收未转义的 URL');
  assert.equal(editor.querySelector('a')?.getAttribute('href'), commandUrl);
  click('#mode-toggle [data-mode="markdown"]');
  assert.match(sourceView(document).state.doc.toString(), /\[选中的文字\]\(https:\/\/example\.com\/\?a=1&b=2\)/, '链接应序列化到 Markdown');

  // An unterminated file header is ambiguous with a Markdown rule: keep it readable, but do not
  // expose it as editable body or let the user accidentally write back partial metadata.
  unclosedFrontMatter = true;
  window.history.pushState(null, '', '/default/welcome?reload=1');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await wait(80);
  click('#btn-edit');
  await wait(20);
  assert.equal($('#edit-wrap').hidden, true, '未闭合的元数据不能进入编辑器');
  assert.match($('#toasts').textContent || '', /元数据围栏未闭合/);
  assert.equal(puts.length, 4, '阻止编辑时不得提交正文');

  // The source editor belongs to the page rather than a bordered, vertically scrolling box.
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const cssRule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] || '';
  };
  assert.doesNotMatch(cssRule('.source-editor'), /border|background|overflow/, '源码区不应再有外框或独立背景');
  assert.doesNotMatch(cssRule('.source-editor .cm-scroller'), /max-height/, '源码区不得设置独立的竖向滚动高度');
  assert.match(cssRule('.source-editor .cm-scroller'), /overflow-x:\s*auto/, '关闭换行后长行仍可横向滚动');
  assert.doesNotMatch(cssRule('.source-editor .cm-editor .cm-gutters'), /padding/, '行号区不能重复叠加正文的上内边距');

  console.log('edit mode assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
