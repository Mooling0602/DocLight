/* Client regression coverage for space locking and challenge-based unlock. */
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^\"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost:4173/default', pretendToBeVisual: true, runScripts: 'outside-only' });
const window = dom.window as any;
const document = window.document as Document;
Object.defineProperty(window, 'crypto', { value: webcrypto });
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo || function () {};
window.Element.prototype.scrollIntoView = function () {};

const password = 'local-test-password';
const salt = '00112233445566778899aabbccddeeff';
const iters = 100;
const page = { slug: 'readable', space: 'default', parent: null, title: '可阅读页面', createdAt: 1, updatedAt: 1 };
const builtInPage = { slug: 'built-in-page', space: 'doclight-default', parent: null, title: '内置页面', createdAt: 1, updatedAt: 1 };
let locked = false;
let challengeCalls = 0;
let nonce = '';
const calls: { url: string; method: string; body: any }[] = [];
const result = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
window.fetch = async (input: string, opts: any = {}) => {
  const url = String(input);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
  calls.push({ url, method, body });
  if (url.includes('/api/auth/state')) return result({ mode: 'ready', authed: true, user: 'tester', salt, iters });
  if (url.includes('/api/auth/challenge')) {
    nonce = `challenge-${++challengeCalls}`;
    return result({ nonce, salt, iters });
  }
  if (url.includes('/api/tree')) {
    return result({ spaces: [
      { slug: 'default', title: '默认空间', desc: '', home: null, createdAt: 1, updatedAt: 1, locked },
      { slug: 'doclight-default', title: '内置空间', desc: '', home: null, createdAt: 1, updatedAt: 1, locked: true, builtIn: true },
    ], pages: [page, builtInPage] });
  }
  if (url.includes('/api/spaces/default/lock') && method === 'POST') {
    if (!body.locked) {
      const key = pbkdf2Sync(password, Buffer.from(salt, 'hex'), iters, 32, 'sha256');
      const expected = createHmac('sha256', key).update(nonce).digest('hex');
      if (!nonce || body.nonce !== nonce || body.proof !== expected) { nonce = ''; return result({ error: '密码错误' }, 401); }
      nonce = '';
    }
    locked = body.locked;
    return result({ ok: true, locked });
  }
  if (url.includes('/api/pages/readable')) return result(method === 'PUT'
    ? { ...page, ...body }
    : { ...page, content: '<p>仍然可以阅读正文</p>' });
  if (url.includes('/api/pages/built-in-page')) return result({ ...builtInPage, content: '内置正文' });
  return result({});
};

const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  assert.ok(el, `未找到 ${selector}`);
  return el;
};
const click = (selector: string) => $(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const openSpaceMenu = async () => { click('.space-row .row-actions [title="空间管理"]'); await wait(); };
const submit = () => click('#modal-root [data-x=ok]');

async function collisionBootTests(): Promise<void> {
  const message = '数据目录中已有空间 doclight-default，请先备份并在 spaces.json 和页面 front matter 中将它改为其他 slug';
  const bundle = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const boot = async (tree: any, status: number) => {
    const instance = new JSDOM(html, { url: 'http://localhost:4173/default/readable', pretendToBeVisual: true, runScripts: 'outside-only' });
    const w = instance.window as any;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};
    w.Element.prototype.scrollTo = function () {};
    w.Element.prototype.scrollIntoView = function () {};
    w.fetch = async (input: string) => String(input).includes('/api/tree')
      ? result(tree, status)
      : String(input).includes('/api/auth/state')
        ? result({ mode: 'ready', authed: false, user: null, salt, iters })
        : result({ ...page, content: '恢复正文' });
    w.eval(bundle);
    await wait(100);
    return instance;
  };
  const conflict = await boot({ error: '服务器的提示文案可以改变', errorCode: 'BUILT_IN_SLUG_CONFLICT' }, 503);
  try {
    const d = conflict.window.document;
    const notice = d.querySelector('[role=alert]');
    assert.ok(notice, '冲突时显示可访问的持久提示');
    assert.match(notice.textContent || '', /服务器的提示文案可以改变/, '应安全显示服务端返回的最新指引');
    assert.match(notice.textContent || '', /重新加载/);
    assert.equal((d.querySelector('#btn-new') as HTMLElement).hidden, true);
    assert.equal((d.querySelector('#empty-state') as HTMLElement).hidden, true);
    assert.equal(d.querySelector('#btn-home-new'), null);
    assert.doesNotMatch(d.querySelector('#page-list')!.textContent || '', /创建空间/);
    assert.equal(conflict.window.location.pathname, '/default/readable', '冲突不应将深链接误判为不存在');
    conflict.window.dispatchEvent(new conflict.window.PopStateEvent('popstate'));
    await wait(4400);
    assert.ok(d.querySelector('[role=alert]'), '提示应持续存在，不能随 toast 消失');
  } finally { conflict.window.close(); }
  for (const [body, status] of [[{ error: 'unrelated private error' }, 503], [{ error: message }, 503], [{ error: message, errorCode: 'BUILT_IN_SLUG_CONFLICT' }, 500]] as const) {
    const other = await boot(body, status);
    try {
      assert.equal(other.window.document.querySelector('[role=alert]'), null, '其他错误不得显示冲突提示');
    } finally { other.window.close(); }
  }
  const recovered = await boot({ spaces: [{ slug: 'default', title: '默认空间', desc: '', home: null, createdAt: 1, updatedAt: 1 }], pages: [page] }, 200);
  try {
    const d = recovered.window.document;
    assert.equal(d.querySelector('[role=alert]'), null, '重新加载成功后不再显示冲突');
    assert.equal((d.querySelector('#btn-new') as HTMLElement).hidden, false);
    assert.match(d.querySelector('#article')!.textContent || '', /恢复正文/);
  } finally { recovered.window.close(); }
}

async function runtimeConflictTests(): Promise<void> {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const rule = css.match(/#runtime-conflict\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /max-height:\s*min\(25%,\s*12rem\)/, '长提示必须保留编辑区空间');
  assert.match(rule, /overflow:\s*auto/, '长提示应可滚动');
  assert.match(rule, /overflow-wrap:\s*anywhere/, '长文本在窄屏上应换行');
  assert.match(rule, /background:\s*var\(--bg-inset\)/);
  assert.match(rule, /color:\s*var\(--text\)/);
  assert.doesNotMatch(rule, /position:\s*(sticky|fixed|absolute)/, '提示不得覆盖页面');
  for (const mode of ['other', 'refresh', 'write'] as const) {
    const instance = new JSDOM(html, { url: 'http://localhost:4173/default/readable', pretendToBeVisual: true, runScripts: 'outside-only' });
    const w = instance.window as any;
    const d = w.document as Document;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};
    w.Element.prototype.scrollTo = function () {};
    w.Element.prototype.scrollIntoView = function () {};
    let trees = 0;
    let mutations = 0;
    const space = { slug: 'default', title: '默认空间', desc: '', home: null, createdAt: 1, updatedAt: 1 };
    w.fetch = async (input: string, opts: any = {}) => {
      const url = String(input);
      if (url.includes('/api/tree')) {
        if (++trees > 1) return result(mode === 'refresh'
          ? { error: '变化后的提示', errorCode: 'BUILT_IN_SLUG_CONFLICT' }
          : { error: '其他错误' }, 503);
        return result({ spaces: [space], pages: [page] });
      }
      if (url.includes('/api/auth/state')) return result({ mode: 'ready', authed: true, user: 'tester', salt, iters });
      if (url.includes('/api/spaces/default') && opts.method === 'PUT') { mutations++; return result({ ...space, sort: 'title_asc' }); }
      if (url.includes('/api/pages/readable') && opts.method === 'PUT' && mode === 'write') {
        mutations++;
        return result({ error: '写入时发生冲突', errorCode: 'BUILT_IN_SLUG_CONFLICT' }, 503);
      }
      return result({ ...page, content: '原文' });
    };
    const clickIn = (selector: string) => {
      const element = d.querySelector(selector);
      assert.ok(element, `未找到 ${selector}`);
      element.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    };
    try {
      w.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
      await wait(100);
      clickIn('#btn-edit');
      clickIn('#mode-toggle [data-mode=markdown]');
      const title = d.querySelector('#title-input') as HTMLInputElement;
      const source = d.querySelector('#source-editor') as HTMLTextAreaElement;
      title.value = '草稿标题'; title.dispatchEvent(new w.Event('input', { bubbles: true }));
      source.value = '# 草稿正文'; source.dispatchEvent(new w.Event('input', { bubbles: true }));
      if (mode === 'write') {
        clickIn('#btn-save');
      } else {
        clickIn('.space-row .row-actions [title="空间管理"]');
        clickIn('#menu-row [data-act=settings]');
        (d.querySelector('#ss-sort') as HTMLSelectElement).value = 'title_asc';
        clickIn('#modal-root [data-x=ok]');
      }
      await wait(120);
      assert.equal(mutations, 1);
      assert.equal(trees, mode === 'write' ? 1 : 2);
      assert.equal(title.value, '草稿标题');
      assert.equal(source.value, '# 草稿正文');
      assert.equal(source.hidden, false);
      assert.equal((d.querySelector('#dirty-pill') as HTMLElement).hidden, false);
      assert.equal((d.querySelector('#edit-wrap') as HTMLElement).hidden, false);
      if (mode !== 'write') assert.match(d.querySelector('#toasts')?.textContent || '', /排序已更新/, '已成功的操作不能误报失败');
      const notice = d.querySelector('#runtime-conflict');
      assert.equal(!!notice, mode !== 'other', '仅特定冲突显示持久提示');
      if (notice) {
        assert.equal(notice.getAttribute('role'), 'alert');
        assert.equal(notice.parentElement, d.querySelector('#main'), '提示应位于主区域，而非覆盖顶部栏');
        assert.equal(notice, d.querySelector('#main')!.firstElementChild, '提示应占据内容上方的正常布局空间');
        assert.equal((notice as HTMLElement).tabIndex, 0, '较长提示可通过键盘滚动');
        assert.equal((notice as HTMLElement).style.cssText, '', '提示样式应由主题样式表提供');
        assert.match(notice.textContent || '', mode === 'write' ? /写入时发生冲突/ : /变化后的提示/);
        assert.match(notice.textContent || '', /重新加载.*草稿.*备份/);
        await wait(4400);
        assert.ok(d.querySelector('#runtime-conflict'), '提示不能随 toast 消失');
        assert.equal(source.value, '# 草稿正文');
      }
    } finally { instance.window.close(); }
  }
}

async function main(): Promise<void> {
  try {
    window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
    await wait(100);
    assert.ok($('#sp-settings').closest('.space-acts'), '未锁定时设置入口位于空间操作区域');
    click('#sp-settings');
    assert.match($('#modal-root h3').textContent || '', /空间设置/, '空间页面可以打开设置');
    click('#modal-root [data-x=no]');
    await openSpaceMenu();
    assert.equal(document.querySelector('#menu-row [data-act=lock]'), null, '侧栏菜单不再直接提供锁定入口');
    click('#menu-row [data-act=settings]');
    assert.match($('#modal-root [data-x=lock]').textContent || '', /锁定空间/, '空间设置提供锁定入口');
    ($<HTMLSelectElement>('#ss-sort')).value = 'title_asc';
    click('#modal-root [data-x=slug]');
    assert.match($('#toasts').textContent || '', /请先保存或放弃/, '未保存设置时不能直接编辑 slug');
    assert.ok(document.querySelector('#ss-sort'), '未保存设置应保留');
    click('#modal-root [data-x=lock]');
    assert.match($('#toasts').textContent || '', /请先保存或放弃/, '未保存设置时不能直接锁定');
    assert.equal(locked, false);
    ($<HTMLSelectElement>('#ss-sort')).value = 'created_desc';
    click('#modal-root [data-x=lock]');
    await wait();
    assert.equal($('#modal-root').hidden, false, '锁定应要求确认');
    submit();
    await wait(120);
    assert.equal(locked, true, '确认后应锁定空间');
    assert.ok(document.querySelector('.space-row .lock-badge'), '侧栏显示锁定状态');
    assert.equal(document.querySelectorAll('#sp-settings').length, 1, '锁定空间只能有一个设置入口');
    assert.equal($('#sp-settings').closest('[hidden]'), null, '设置入口应可见');
    assert.ok($('#sp-settings').closest('.space-acts'), '锁定后设置入口仍位于空间操作区域');
    assert.equal($('#sp-add').hidden, true, '锁定后新建入口隐藏');
    assert.ok($('#sp-sort').closest('[hidden]'), '锁定后排序控件隐藏');
    assert.ok($('#sp-recommend').closest('[hidden]'), '锁定后推荐控件隐藏');
    click('#sp-settings');
    assert.match($('#modal-root [data-x=lock]').textContent || '', /解锁空间/, '锁定后空间页面仍能打开解锁设置');
    assert.equal($<HTMLButtonElement>('#modal-root [data-x=slug]').disabled, true, '锁定时不能编辑空间 slug');
    assert.equal($<HTMLSelectElement>('#ss-sort').disabled, true);
    click('#modal-root [data-x=no]');
    assert.equal(document.querySelector('.space-row [title="在此空间新建页面"]'), null, '锁定后不能新建页面');
    assert.equal(document.querySelector('.tree-row [title="新建子页面"]'), null, '锁定后不能新建子页面');
    assert.equal(document.querySelector('.tree-row [title="更多操作"]'), null, '锁定后不能操作页面');
    await openSpaceMenu();
    assert.equal(document.querySelector('#menu-row [data-act=lock]'), null, '菜单不直接提供解锁入口');
    assert.ok(document.querySelector('#menu-row [data-act=settings]'), '锁定空间仍可进入设置解锁');
    assert.equal(document.querySelector('#menu-row [data-act=delete]'), null, '锁定空间不可删除');
    click('.tree-row .page-item');
    await wait(100);
    assert.equal($('#cluster-view').hidden, true, '锁定页面不应显示空的操作栏');
    assert.equal($('#article').hidden, false, '锁定空间的页面仍可阅读');
    assert.match($('#article').textContent || '', /仍然可以阅读正文/, '锁定页面正文应正常显示');
    assert.equal($('#btn-edit').hidden, true, '锁定页面不可编辑');
    assert.equal($('#btn-more').hidden, true, '锁定页面不可通过页面菜单修改');

    await openSpaceMenu();
    click('#menu-row [data-act=settings]');
    assert.match($('#modal-root [data-x=lock]').textContent || '', /解锁空间|锁定空间/);
    if (locked) {
      assert.equal($<HTMLSelectElement>('#ss-sort').disabled, true);
      assert.equal($<HTMLInputElement>('#ss-recommend').disabled, true);
      assert.equal($<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, true);
    }
    click('#modal-root [data-x=lock]');
    await wait();
    const pass = $<HTMLInputElement>('#modal-root input[type=password]');
    pass.value = 'wrong-password';
    submit();
    await wait(150);
    assert.equal(locked, true, '错误密码不能解锁');
    assert.equal($('#modal-root').hidden, false, '错误密码后应保留对话框');
    assert.ok(challengeCalls >= 1, '解锁需要服务器 challenge');
    $<HTMLInputElement>('#modal-root input[type=password]').value = password;
    submit();
    await wait(200);
    assert.equal(locked, false, '正确密码应解锁');
    assert.ok(challengeCalls >= 2, '重试必须获取新的 challenge');
    const unlockCalls = calls.filter(c => c.url.includes('/api/spaces/default/lock') && c.body?.locked === false);
    assert.equal(unlockCalls.length, 2, '错误密码及正确密码分别提交一次');
    for (const c of unlockCalls) {
      assert.equal(typeof c.body.nonce, 'string');
      assert.match(c.body.proof, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(c.body).includes(password), '不得将明文密码发送到服务器');
    }
    assert.notEqual(unlockCalls[0].body.nonce, unlockCalls[1].body.nonce, '每次验证使用不同 nonce');
    assert.ok(document.querySelector('.space-row [title="在此空间新建页面"]'), '解锁后恢复新建入口');
    assert.equal($('#btn-edit').hidden, false, '解锁后恢复编辑入口');
    assert.equal($('#cluster-view').hidden, false, '解锁后恢复页面操作栏');

    click('#btn-edit');
    click('#mode-toggle [data-mode=markdown]');
    const title = $<HTMLInputElement>('#title-input');
    const source = $<HTMLTextAreaElement>('#source-editor');
    title.value = '未保存标题';
    title.dispatchEvent(new window.Event('input', { bubbles: true }));
    source.value = '# 未保存草稿';
    source.dispatchEvent(new window.Event('input', { bubbles: true }));
    await openSpaceMenu();
    click('#menu-row [data-act=settings]');
    assert.match($('#modal-root [data-x=lock]').textContent || '', /解锁空间|锁定空间/);
    if (locked) {
      assert.equal($<HTMLSelectElement>('#ss-sort').disabled, true);
      assert.equal($<HTMLInputElement>('#ss-recommend').disabled, true);
      assert.equal($<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, true);
    }
    click('#modal-root [data-x=lock]');
    await wait();
    submit();
    await wait(120);
    assert.equal(locked, true);
    const badge = $<HTMLElement>('#cluster-edit .editor-lock-badge');
    assert.equal(badge.hidden, false, '编辑期间锁定应持续显示只读状态');
    assert.match(badge.textContent || '', /只读.*草稿保留.*解锁后可保存/);
    assert.equal(title.value, '未保存标题');
    assert.equal(source.value, '# 未保存草稿');
    assert.equal(source.hidden, false, '锁定不应切换编辑模式');
    assert.equal($('#dirty-pill').hidden, false, '锁定不应清除未保存状态');
    click('#btn-save');
    await wait();
    assert.equal(calls.filter(c => c.url.includes('/api/pages/readable') && c.method === 'PUT').length, 0, '锁定时不得保存');
    await openSpaceMenu();
    click('#menu-row [data-act=settings]');
    assert.match($('#modal-root [data-x=lock]').textContent || '', /解锁空间|锁定空间/);
    if (locked) {
      assert.equal($<HTMLSelectElement>('#ss-sort').disabled, true);
      assert.equal($<HTMLInputElement>('#ss-recommend').disabled, true);
      assert.equal($<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, true);
    }
    click('#modal-root [data-x=lock]');
    await wait();
    $<HTMLInputElement>('#modal-root input[type=password]').value = password;
    submit();
    await wait(200);
    assert.equal(locked, false);
    assert.equal(badge.hidden, true, '解锁后移除编辑器锁定提示');
    assert.equal(title.value, '未保存标题');
    assert.equal(source.value, '# 未保存草稿');
    click('#btn-save');
    await wait(120);
    const saves = calls.filter(c => c.url.includes('/api/pages/readable') && c.method === 'PUT');
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].body, { title: '未保存标题', content: '# 未保存草稿' });
    click('a.brand');
    await wait(100);
    assert.match($('a.card[href="/doclight-default"] .lock-badge').textContent || '', /永久只读/, '空间总览显示永久只读');
    assert.match($('a.card[href="/doclight-default"] .s').textContent || '', /随应用更新/, '内置空间不应显示固定模板日期');
    const builtInRow = $('a.space-title[href="/doclight-default"]').closest('.space-row')!;
    assert.match(builtInRow.textContent || '', /永久只读/, '内置空间侧栏显示永久只读');
    assert.equal(builtInRow.querySelector('[title="空间管理"]'), null, '内置空间没有管理菜单');
    assert.equal(builtInRow.querySelector('[title="在此空间新建页面"]'), null);
    click('a.space-title[href="/doclight-default"]');
    await wait(100);
    assert.match($('#article .lock-badge').textContent || '', /永久只读/, '空间页显示永久只读');
    assert.equal($<HTMLElement>('.space-acts').hidden, true);
    click('a.card[data-nav]');
    await wait(100);
    assert.match($('#article .lock-badge').textContent || '', /永久只读/, '页面显示永久只读');
    assert.match($('#article').textContent || '', /随应用更新/, '内置页面不应显示固定模板日期');
    assert.match($('#article').textContent || '', /内置正文/);
    assert.equal($('#btn-edit').hidden, true);
    assert.equal($('#btn-more').hidden, true);
    assert.equal($('#cluster-view').hidden, true, '内置页面不显示空操作栏');
    assert.equal($('#article').hidden, false, '内置页面仍可阅读');
    assert.equal(calls.filter(c => c.url.includes('/api/spaces/doclight-default/lock')).length, 0);
    await collisionBootTests();
    await runtimeConflictTests();
    console.log('space lock UI assertions passed');
  } finally { dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
