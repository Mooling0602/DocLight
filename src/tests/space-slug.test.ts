/*
 * Space and page slug editing regression tests.
 *
 * Pages have always been renameable by slug; spaces were not. Both entries now live in the
 * space settings / article meta line instead of the row menus, and both are writes, so an
 * unauthenticated click has to raise the login dialog instead of the rename prompt, a
 * cancelled login has to leave the data untouched, and a successful login has to resume the
 * flow that was interrupted.
 */
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
const bundle = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

// The client derives its login proof with PBKDF2 + HMAC-SHA256. JSDOM exposes no
// `crypto.subtle`, so the bundle takes its pure-JS fallback there; Node computes the same
// values for the mocked server, which lets the test check the real proof instead of spying.
const SALT = '00112233445566778899aabbccddeeff';
const ITERS = 100;
const PASSWORD = 'local-test-password';
/** The one account the mocked server accepts, and the name the login POST has to carry. */
const LOGIN_USER = 'tester';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until `check` passes: the app paints after a chain of awaited fetches. */
async function waitFor(check: () => boolean, label: string, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`等待超时：${label}`);
}

interface Call { url: string; method: string; body: any }
interface SpaceRow { slug: string; title: string; desc: string; home: string | null; createdAt: number; updatedAt: number }
interface PageRow { slug: string; space: string; parent: string | null; title: string; createdAt: number; updatedAt: number }

/** Boot one client instance against a mocked API that records every request it receives. */
async function createApp({ url = '/default', authed: initialAuthed = true }: { url?: string; authed?: boolean } = {}) {
  const instance = new JSDOM(html, { url: 'http://localhost:4173' + url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = instance.window as any;
  const d = w.document as Document;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(w, 'localStorage', {
    value: { _s: {} as Record<string, string>, getItem(key: string) { return this._s[key] ?? null; }, setItem(key: string, value: string) { this._s[key] = value; } },
    configurable: true,
  });
  w.scrollTo = () => {};
  w.Element.prototype.scrollTo = w.Element.prototype.scrollTo || function () {};
  w.Element.prototype.scrollIntoView = function () {};

  const now = Date.now();
  const spaces: SpaceRow[] = [{ slug: 'default', title: '默认空间', desc: '', home: null, createdAt: now, updatedAt: now }];
  const pages: PageRow[] = [{ slug: 'welcome', space: 'default', parent: null, title: '欢迎', createdAt: now, updatedAt: now }];
  const calls: Call[] = [];
  let authed = initialAuthed;
  let nonce = '';
  const result = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  w.fetch = async (input: string, opts: any = {}) => {
    const request = String(input);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ url: request, method, body });
    if (request.endsWith('/api/auth/state')) {
      return result({ mode: 'ready', authed, user: authed ? LOGIN_USER : null, salt: SALT, iters: ITERS });
    }
    if (request.endsWith('/api/auth/challenge')) {
      nonce = `challenge-${calls.length}`;
      return result({ nonce, salt: SALT, iters: ITERS });
    }
    if (request.endsWith('/api/auth/login')) {
      const key = pbkdf2Sync(PASSWORD, Buffer.from(SALT, 'hex'), ITERS, 32, 'sha256');
      const expected = createHmac('sha256', key).update(nonce).digest('hex');
      // The login POST carries the name with the proof; a wrong name is refused like a bad one.
      if (!nonce || body?.nonce !== nonce || body?.proof !== expected || body?.user !== LOGIN_USER) { nonce = ''; return result({ error: '用户名或密码错误' }, 401); }
      nonce = '';
      authed = true;
      return result({ ok: true });
    }
    if (request.endsWith('/api/tree')) {
      return result({ spaces: spaces.map(s => ({ ...s })), pages: pages.map(p => ({ ...p })) });
    }
    const spaceHit = request.match(/\/api\/spaces\/([^/]+)$/);
    if (spaceHit) {
      const found = spaces.find(s => s.slug === decodeURIComponent(spaceHit[1]));
      if (!found) return result({ error: '空间不存在' }, 404);
      if (method === 'PUT') Object.assign(found, body);
      return result({ ...found });
    }
    const pageHit = request.match(/\/api\/pages\/([^/]+)$/);
    if (pageHit) {
      const found = pages.find(p => p.slug === decodeURIComponent(pageHit[1]));
      if (!found) return result({ error: '页面不存在' }, 404);
      if (method === 'PUT') {
        const old = found.slug;
        Object.assign(found, body);
        // Pages reference their parent by slug, so a rename has to be followed by children too.
        pages.forEach(p => { if (p.parent === old) p.parent = found.slug; });
      }
      return result({ ...found, content: `<p>${found.title}正文</p>` });
    }
    return result({});
  };

  w.eval(bundle);

  const get = <T extends Element = HTMLElement>(selector: string): T => {
    const element = d.querySelector<T>(selector);
    assert.ok(element, `未找到元素 ${selector}`);
    return element;
  };
  const exists = (selector: string) => !!d.querySelector(selector);
  const click = (selector: string) => {
    get(selector).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const modalText = () => d.querySelector('#modal-root')?.textContent || '';
  const modalTitle = () => d.querySelector('#modal-root h3')?.textContent || '';
  const modalOpen = () => !(d.querySelector('#modal-root') as HTMLElement | null)?.hidden;
  /** Fill the login dialog and submit it; resolves once the round trip settled. */
  const login = async (password: string) => {
    get<HTMLInputElement>('#lg-user').value = LOGIN_USER;
    get<HTMLInputElement>('#lg-pass').value = password;
    click('#modal-root [data-x=ok]');
    await wait(60);
  };
  const writes = () => calls.filter(c => c.method === 'PUT' || c.method === 'DELETE');
  const putBodies = (suffix: string) =>
    calls.filter(c => c.method === 'PUT' && c.url.endsWith(suffix)).map(c => c.body);

  return { dom: instance, w, d, calls, get, exists, click, login, modalText, modalTitle, modalOpen, writes, putBodies, spaces, pages };
}

/** Signed-in rename of a space path: the plain flow, with no login dialog in the way. */
async function authedSpaceSlugFlow(): Promise<void> {
  const app = await createApp();
  try {
    const { w, get, click, modalText, writes, calls } = app;
    await waitFor(() => app.exists('#sp-slug'), '空间索引渲染');

    // With home: null the space index is shown, where the slug chip lives
    const chip = get('#sp-slug');
    assert.equal(chip.textContent, '#default', 'space index should expose its slug');
    assert.notEqual(chip.tagName, 'A', 'space slug is a label, not a second edit entry');

    // The sidebar page link is built from the page → space chain
    assert.equal(get('.tree-row .page-item').getAttribute('href'), '/default/welcome', 'page link uses the space chain');

    // The inline quick actions must also be reachable from the sidebar space row. They are
    // hidden until hover by CSS, and a rule that only targeted .tree-row left the space
    // menu permanently invisible on desktop, so both the DOM entry and the reveal rule
    // are asserted here.
    const actions = get('.space-row .row-actions');
    const more = actions.querySelectorAll('.ra-btn')[1];
    more.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait();
    const rowMenu = get('#menu-row');
    assert.equal(rowMenu.hidden, false, 'space row menu should open');
    assert.equal(rowMenu.dataset.kind, 'space', 'space row menu should be in space mode');
    assert.equal(rowMenu.querySelector('[data-act="slug"]'), null, 'path editing lives in 空间设置, not the row menu');

    const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
    assert.match(css, /\.space-row:hover \.row-actions/, 'CSS must reveal space row actions on hover');

    click('#sp-settings');
    await waitFor(() => /空间设置/.test(modalText()), '空间设置弹窗');
    assert.match(get('#modal-root [data-x=slug]').textContent || '', /编辑路径/, '设置弹窗提供路径入口');
    click('#modal-root [data-x=slug]');
    await waitFor(() => /编辑空间路径/.test(modalText()), '空间路径编辑框');
    assert.equal(app.modalOpen(), true, 'slug prompt should open');
    assert.equal(calls.filter(c => c.url.endsWith('/api/auth/login')).length, 0, '已登录时直接进入编辑框');

    get<HTMLInputElement>('#modal-root input').value = 'My New Space!';
    click('#modal-root [data-x=ok]');
    await waitFor(() => app.putBodies('/api/spaces/default').length === 1, '空间路径 PUT');
    await waitFor(() => get('#sp-slug').textContent === '#my_new_space', '空间路径更新');

    assert.deepEqual(app.putBodies('/api/spaces/default'), [{ slug: 'my_new_space' }], 'the normalized slug is sent');
    assert.equal(w.location.pathname, '/my_new_space', 'the address bar follows the rename');
    assert.equal(get('.space-title').getAttribute('href'), '/my_new_space', 'the sidebar space link re-points');
    assert.equal(
      get('.tree-row .page-item').getAttribute('href'),
      '/my_new_space/welcome',
      'page links follow the renamed space',
    );
    assert.deepEqual(writes().filter(c => c.url !== '/api/spaces/default'), [], '只有一次写入');
  } finally { app.dom.window.close(); }
}

/** A signed-out click on the space path entry prompts for login, and a cancel writes nothing. */
async function unauthedSpacePathFlow(): Promise<void> {
  const app = await createApp({ authed: false });
  try {
    const { w, get, click, login, modalText, modalTitle, modalOpen, writes, putBodies, calls } = app;
    await waitFor(() => app.exists('#sp-settings'), '空间索引渲染');

    // Editing the path lives in 空间设置, which stays readable when signed out; the write
    // that follows it is what needs an account.
    click('#sp-settings');
    await waitFor(() => /空间设置/.test(modalText()), '空间设置弹窗');
    click('#modal-root [data-x=slug]');
    await waitFor(() => /登录 DocLight/.test(modalTitle()), '未登录时弹出登录框');

    assert.equal(modalOpen(), true, '未登录时编辑空间路径应弹出登录框');
    assert.match(modalText(), /修改内容前需要登录/, '登录框应说明为什么需要登录');
    assert.doesNotMatch(modalText(), /编辑空间路径/, '未登录不得直接进入路径编辑');
    assert.ok(get('#lg-pass'), '登录框应提供密码输入');
    assert.deepEqual(writes(), [], '未登录不得发起写入请求');

    // Cancel closes the dialog and leaves the data and the address bar untouched.
    click('#modal-root [data-x=no]');
    await waitFor(() => !modalOpen(), '取消后关闭登录框');
    assert.deepEqual(writes(), [], '取消登录后不得写入');
    assert.equal(calls.filter(c => c.url.endsWith('/api/auth/login')).length, 0, '取消登录不得发起登录请求');
    assert.equal(get('#sp-slug').textContent, '#default', '取消后空间路径不变');
    assert.equal(w.location.pathname, '/default', '取消后地址不变');

    // A rejected password keeps the dialog up, reports the reason and still writes nothing.
    click('#sp-settings');
    await waitFor(() => /空间设置/.test(modalText()), '空间设置弹窗');
    click('#modal-root [data-x=slug]');
    await waitFor(() => /登录 DocLight/.test(modalTitle()), '再次弹出登录框');
    await login('wrong-password');
    await waitFor(() => /密码错误/.test(get('#lg-err').textContent || ''), '密码错误提示');
    assert.equal(modalOpen(), true, '密码错误后应保留登录框');
    assert.equal(get<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, false, '失败后应允许重试');
    assert.deepEqual(writes(), [], '密码错误不得写入');
    assert.equal(calls.filter(c => c.url.endsWith('/api/auth/login')).length, 1, '一次失败尝试');

    // A successful login resumes the rename that was interrupted.
    await login(PASSWORD);
    await waitFor(() => /编辑空间路径/.test(modalText()), '登录成功后继续编辑空间路径');
    const input = get<HTMLInputElement>('#modal-root input');
    assert.equal(input.value, 'default', '续跑时带出当前路径');
    input.value = 'My New Space!';
    click('#modal-root [data-x=ok]');
    await waitFor(() => putBodies('/api/spaces/default').length === 1, '续跑的 PUT');
    await waitFor(() => get('#sp-slug').textContent === '#my_new_space', '空间路径更新');

    assert.deepEqual(putBodies('/api/spaces/default'), [{ slug: 'my_new_space' }], '登录成功后完成原本的空间路径修改');
    assert.equal(w.location.pathname, '/my_new_space', '地址栏跟随空间路径');
    const loginBody = JSON.stringify(calls.find(c => c.url.endsWith('/api/auth/login') && c.body?.proof)?.body);
    assert.equal(loginBody.includes(PASSWORD), false, '不得将明文密码发往服务器');
  } finally { app.dom.window.close(); }
}

/** A signed-out click on the page path entry prompts for login, then resumes the rename. */
async function unauthedPagePathFlow(): Promise<void> {
  const app = await createApp({ url: '/default/welcome', authed: false });
  try {
    const { w, get, click, login, modalText, modalTitle, modalOpen, writes, putBodies } = app;
    await waitFor(() => app.exists('#slug-edit'), '文章渲染');

    // The slug chip in the article meta line is the page's own path entry.
    assert.equal(get('#slug-edit').textContent, '#welcome', '页面显示自己的路径');
    click('#slug-edit');
    await waitFor(() => /登录 DocLight/.test(modalTitle()), '未登录时编辑页面路径应弹出登录框');
    assert.equal(modalOpen(), true, '未登录时编辑页面路径应弹出登录框');
    assert.doesNotMatch(modalText(), /编辑页面路径/, '未登录不得直接进入路径编辑');
    assert.deepEqual(writes(), [], '未登录不得写入页面');

    click('#modal-root [data-x=no]');
    await waitFor(() => !modalOpen(), '取消后关闭登录框');
    assert.deepEqual(writes(), [], '取消登录后不得写入页面');
    assert.equal(get('#slug-edit').textContent, '#welcome', '取消后页面路径不变');
    assert.equal(w.location.pathname, '/default/welcome', '取消后保持在当前页面');

    // The top-bar page menu reaches the same flow, so that entry is gated too.
    click('#btn-more');
    await wait();
    assert.equal(get('#menu-page').hidden, false, '页面菜单应打开');
    click('#menu-page [data-act=slug]');
    await waitFor(() => /登录 DocLight/.test(modalTitle()), '菜单入口同样先要求登录');
    assert.deepEqual(writes(), [], '未登录时菜单入口同样不写入');

    // After a successful login the rename dialog opens on the current page and completes.
    await login(PASSWORD);
    await waitFor(() => /编辑页面路径/.test(modalText()), '登录成功后继续编辑页面路径');
    const input = get<HTMLInputElement>('#modal-root input');
    assert.equal(input.value, 'welcome', '续跑时带出当前路径');
    input.value = 'New Welcome!';
    click('#modal-root [data-x=ok]');
    await waitFor(() => putBodies('/api/pages/welcome').length === 1, '续跑的页面 PUT');
    await waitFor(() => w.location.pathname === '/default/new_welcome', '地址栏跟随页面路径');

    assert.deepEqual(putBodies('/api/pages/welcome'), [{ slug: 'new_welcome' }], '登录成功后完成原本的页面路径修改');
    await waitFor(() => get('#slug-edit').textContent === '#new_welcome', '新页面路径已生效');
  } finally { app.dom.window.close(); }
}

async function main(): Promise<void> {
  await authedSpaceSlugFlow();
  await unauthedSpacePathFlow();
  await unauthedPagePathFlow();
  console.log('space slug assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
