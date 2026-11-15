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
    return result({ spaces: [{ slug: 'default', title: '默认空间', desc: '', home: null, createdAt: 1, updatedAt: 1, locked }], pages: [page] });
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
  if (url.includes('/api/pages/readable')) return result({ ...page, content: '<p>仍然可以阅读正文</p>' });
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

async function main(): Promise<void> {
  try {
    window.eval(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
    await wait(100);
    await openSpaceMenu();
    assert.match($('#menu-row [data-act=lock]').textContent || '', /锁定空间/, '侧栏菜单提供锁定入口');
    click('#menu-row [data-act=lock]');
    await wait();
    assert.equal($('#modal-root').hidden, false, '锁定应要求确认');
    submit();
    await wait(120);
    assert.equal(locked, true, '确认后应锁定空间');
    assert.ok(document.querySelector('.space-row .lock-badge'), '侧栏显示锁定状态');
    assert.equal(document.querySelector('.space-row [title="在此空间新建页面"]'), null, '锁定后不能新建页面');
    assert.equal(document.querySelector('.tree-row [title="新建子页面"]'), null, '锁定后不能新建子页面');
    assert.equal(document.querySelector('.tree-row [title="更多操作"]'), null, '锁定后不能操作页面');
    await openSpaceMenu();
    assert.match($('#menu-row [data-act=lock]').textContent || '', /解锁空间/, '菜单状态应更新为解锁');
    assert.equal(document.querySelector('#menu-row [data-act=settings]'), null, '锁定空间不可修改设置');
    assert.equal(document.querySelector('#menu-row [data-act=delete]'), null, '锁定空间不可删除');
    click('.tree-row .page-item');
    await wait(100);
    assert.equal($('#cluster-view').hidden, false, '锁定空间的页面仍可阅读');
    assert.match($('#article').textContent || '', /仍然可以阅读正文/, '锁定页面正文应正常显示');
    assert.equal($('#btn-edit').hidden, true, '锁定页面不可编辑');
    assert.equal($('#btn-more').hidden, true, '锁定页面不可通过页面菜单修改');

    await openSpaceMenu();
    click('#menu-row [data-act=lock]');
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
    console.log('space lock UI assertions passed');
  } finally { dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
