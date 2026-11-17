/*
 * Login dialog regression coverage.
 *
 * The dialog is drawn into the one shared `.modal` node and it wraps a caller's continuation
 * (`then`) that usually opens the editor or another modal. Three defects lived in that seam:
 *
 *   1. the Enter handler was attached to `.modal` itself, which `innerHTML = ''` does not
 *      clean, so every reopening left a listener behind and a single Enter ran several
 *      submissions — each of them reading the current dialog's inputs through `$(sel, m)`;
 *   2. `submit` had no in-flight guard, so a second Enter (or a click while the button was
 *      still reachable) started another challenge/login round trip;
 *   3. `submit` never noticed a cancellation, so a dismissed dialog still called `then()` when
 *      the request finally settled and opened the editor behind the user's back.
 *
 * A cancel also cannot simply ignore the outstanding request: the server may already have
 * accepted the credentials, so the client still has to re-read the session state — it just
 * must not resume the interrupted flow afterwards.
 */
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';
import { buildSync } from 'esbuild';

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^"]*" defer><\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');
// Build from source rather than reading `public/app.js`: the shipped bundle is a build artefact
// and a stale copy would let a regression pass unnoticed.
const bundle = buildSync({
  entryPoints: [path.join(root, 'src/client/app.ts')],
  bundle: true, write: false, platform: 'browser', format: 'iife',
}).outputFiles[0].text;

// The client derives its proof with PBKDF2 + HMAC-SHA256; the mocked server recomputes the
// same values with node:crypto, so these tests exercise the real protocol rather than a stub.
const SALT = '00112233445566778899aabbccddeeff';
const ITERS = 100;
const PASSWORD = 'local-test-password';
// The one account the mocked server knows. The login POST carries the name next to the proof,
// so the mock checks it the way the real endpoint is expected to.
const ACCOUNT = 'tester';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until `check` passes: the client paints after a chain of awaited fetches. */
async function waitFor(check: () => boolean, label: string, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`等待超时：${label}`);
}

const expectedKs = () => pbkdf2Sync(PASSWORD, Buffer.from(SALT, 'hex'), ITERS, 32, 'sha256').toString('hex');

interface Call { url: string; method: string; body: any }

/**
 * Replace `localStorage` with a store that throws on every access, the way a browser with site
 * data blocked behaves. Reading preferences and remembering the account name both go through it.
 */
function brokenStorage(w: any): void {
  const boom = () => { throw new Error('storage disabled'); };
  const stub = { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, get length(): number { return boom(); } };
  Object.defineProperty(w, 'localStorage', { value: stub, configurable: true });
}

/** Every key the client persisted, so a test can assert nothing sensitive was written. */
function storedEntries(w: any): Array<[string, string]> {
  const store = w.localStorage;
  const out: Array<[string, string]> = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    out.push([key, store.getItem(key)]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

const LOGIN_USER_KEY = 'doclight-login-user';

/**
 * Boot one client against a mocked API. `holdNext` parks the next request to a given endpoint
 * so a test can dismiss the dialog while that request is still outstanding.
 *
 * `storage` injects a broken `localStorage` (privacy mode, disabled site data): every method
 * throws, which the client has to survive rather than let it break the sign-in. `stored` seeds
 * the store before the bundle runs, i.e. it simulates a page reload that finds the memory.
 * `anonUser` makes the anonymous state response name an account, which is what the server does
 * for a visitor whose session ended: the login form must ignore it.
 */
async function createApp({
  authed = false, setupMode = false, path: pathname = '/docs/guide',
  storage = 'native' as 'native' | 'broken', stored = {} as Record<string, string>,
  anonUser = null as string | null,
} = {}) {
  const instance = new JSDOM(html, { url: 'http://localhost:4173' + pathname, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = instance.window as any;
  const d = w.document as Document;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.Element.prototype.scrollTo = w.Element.prototype.scrollTo || function () {};
  w.Element.prototype.scrollIntoView = function () {};
  if (storage === 'broken') brokenStorage(w);
  else Object.entries(stored).forEach(([key, value]) => w.localStorage.setItem(key, value));

  const calls: Call[] = [];
  let authedState = authed;
  let nonce = '';
  let gate: { suffix: string; promise: Promise<void>; release: () => void } | null = null;
  const now = Date.now();
  const spaces = [{ slug: 'docs', title: '文档', desc: '', home: null, createdAt: now, updatedAt: now }];
  const pages = [{ slug: 'guide', space: 'docs', parent: null, title: '指南', createdAt: now, updatedAt: now }];
  const result = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  w.fetch = async (input: string, opts: any = {}) => {
    const request = String(input);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ url: request, method, body });
    // Park the request before answering: the dialog is dismissed while it is in flight.
    if (gate && request.endsWith(gate.suffix)) { const current = gate; gate = null; await current.promise; }
    if (request.endsWith('/api/auth/state')) {
      return result({ mode: setupMode && !authedState ? 'setup' : 'ready', authed: authedState, user: authedState ? ACCOUNT : anonUser, salt: SALT, iters: ITERS });
    }
    if (request.endsWith('/api/auth/challenge')) {
      nonce = `challenge-${calls.length}`;
      return result({ nonce, salt: SALT, iters: ITERS });
    }
    if (request.endsWith('/api/auth/logout')) {
      authedState = false;
      return result({ ok: true });
    }
    if (request.endsWith('/api/auth/login')) {
      const key = pbkdf2Sync(PASSWORD, Buffer.from(SALT, 'hex'), ITERS, 32, 'sha256');
      const proof = createHmac('sha256', key).update(nonce).digest('hex');
      // The client submits the name, the nonce and the proof together. A wrong name is refused
      // the same way a wrong password is, and both leave the nonce unusable.
      if (!nonce || body?.nonce !== nonce || body?.proof !== proof || body?.user !== ACCOUNT) {
        nonce = '';
        return result({ error: body?.user !== ACCOUNT && body?.proof === proof ? '用户名或密码错误' : '密码错误' }, 401);
      }
      nonce = '';
      authedState = true;
      return result({ ok: true, user: ACCOUNT });
    }
    if (request.endsWith('/api/auth/setup')) {
      if (!body?.user || body?.ks !== expectedKs()) return result({ error: '密钥不符' }, 401);
      authedState = true;
      return result({ ok: true });
    }
    if (request.endsWith('/api/tree')) {
      return result({ spaces: spaces.map(s => ({ ...s })), pages: pages.map(p => ({ ...p })) });
    }
    const pageHit = request.match(/\/api\/pages\/([^/]+)$/);
    if (pageHit) return result({ ...pages[0], content: '<p>指南正文</p>' });
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
  const pressEnter = (selector: string) => {
    get(selector).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const pressEscape = () => {
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };
  const modalOpen = () => !get<HTMLElement>('#modal-root').hidden;
  const modalText = () => d.querySelector('#modal-root')?.textContent || '';
  const holdNext = (suffix: string) => {
    let release: () => void = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    gate = { suffix, promise, release };
    return release;
  };
  const counts = (suffix: string) => calls.filter(c => c.url.endsWith(suffix)).length;
  /** The bodies of the login attempts, in order, so a test can assert what the wire carried. */
  const loginBodies = () => calls.filter(c => c.url.endsWith('/api/auth/login')).map(c => c.body);
  const fill = (user: string, pass: string) => {
    get<HTMLInputElement>('#lg-user').value = user;
    get<HTMLInputElement>('#lg-pass').value = pass;
  };

  return {
    dom: instance, w, d, calls, get, exists, click, pressEnter, pressEscape,
    modalOpen, modalText, holdNext, counts, loginBodies, fill,
    editorOpen: () => !get<HTMLElement>('#edit-wrap').hidden,
    authButton: () => get<HTMLButtonElement>('#btn-auth'),
    storedUser: (): string | null => {
      try { return w.localStorage.getItem(LOGIN_USER_KEY); } catch { return null; }
    },
    storedEntries: (): Array<[string, string]> => storedEntries(w),
  };
}

/** Open the login dialog from the article's 编辑 button (the caller that resumes `enterEdit`). */
async function openFromEditButton(app: Awaited<ReturnType<typeof createApp>>): Promise<void> {
  await waitFor(() => !app.get('#cluster-view').hidden, '文章工具条渲染');
  app.click('#btn-edit');
  await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '登录弹窗打开');
}

/** Dismissing mid-flight must sync the session but never resume the interrupted flow. */
async function cancelMidFlightSyncsWithoutResuming(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    const release = app.holdNext('/api/auth/login');
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.counts('/api/auth/login') === 1, '登录请求已发出');
    assert.match(app.modalText(), /验证中…/, '提交中应显示进行中的状态');

    app.click('#modal-root .modal-backdrop');
    assert.equal(app.modalOpen(), false, '取消应立即关闭弹窗');
    assert.equal(app.exists('#lg-pass'), false, '取消后输入框应移除');

    release();
    // The reply undoes the request; give the client room to finish its bookkeeping.
    await wait(200);

    assert.equal(app.counts('/api/auth/login'), 1, '不应因为取消而重发登录');
    assert.equal(app.editorOpen(), false, '取消后不得继续打开编辑弹窗');
    assert.equal(app.get('#cluster-view').hidden, false, '文章页仍停留在阅读态');
    assert.equal(app.authButton().hidden, true, '文章页不显示登录入口');

    // The login was accepted server-side, so the session state must have been re-read.
    const loginAt = app.calls.findIndex(c => c.url.endsWith('/api/auth/login'));
    const stateAfterLogin = app.calls.slice(loginAt + 1).filter(c => c.url.endsWith('/api/auth/state'));
    assert.equal(stateAfterLogin.length, 1, '取消后仍要回读会话状态，避免客户端以为未登录');

    // And the synced state has to be real: a later click continues without asking again.
    app.click('#btn-edit');
    await wait(60);
    assert.equal(app.modalOpen(), false, '已登录时不应再弹登录框');
    assert.equal(app.counts('/api/auth/challenge'), 1, '已登录时不应再发起挑战');
    assert.equal(app.editorOpen(), true, '会话状态同步后编辑可以直接进入');
  } finally { app.dom.window.close(); }
}

/** Cancelling before the credentials leave the client sends nothing at all. */
async function cancelBeforeDispatchSendsNothing(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    const release = app.holdNext('/api/auth/challenge');
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.counts('/api/auth/challenge') === 1, '挑战请求已发出');

    app.pressEscape();
    assert.equal(app.modalOpen(), false, 'Escape 应关闭弹窗');

    release();
    await wait(200);

    assert.equal(app.counts('/api/auth/login'), 0, '取消后不得再发送登录请求');
    assert.equal(app.editorOpen(), false, '取消后不得继续打开编辑弹窗');
    assert.equal(app.exists('#lg-pass'), false);

    // Nothing was accepted, so the next attempt still has to authenticate.
    app.click('#btn-edit');
    await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '再次弹出登录框');
  } finally { app.dom.window.close(); }
}

/** Reopening the dialog must not leave a second Enter handler on the shared `.modal` node. */
async function reopeningDoesNotStackEnterHandlers(): Promise<void> {
  const app = await createApp();
  try {
    for (let round = 0; round < 3; round += 1) {
      await openFromEditButton(app);
      app.click('#modal-root [data-x=no]');
      await waitFor(() => !app.modalOpen(), `第 ${round + 1} 次取消`);
    }
    assert.equal(app.counts('/api/auth/challenge'), 0, '取消不得发起请求');

    await openFromEditButton(app);
    app.fill(ACCOUNT, PASSWORD);
    app.pressEnter('#lg-pass');
    // Count the requests before waiting for the continuation: a stacked handler shows up here as
    // several round trips, whereas waiting first would only report a timeout.
    await waitFor(() => app.counts('/api/auth/challenge') >= 1, '挑战请求已发出');
    await wait(150);
    assert.equal(app.counts('/api/auth/challenge'), 1, '重开后一次 Enter 只应发起一次挑战');
    assert.equal(app.counts('/api/auth/login'), 1, '重开后一次 Enter 只应发起一次登录');
    await waitFor(() => app.editorOpen(), '登录成功后继续编辑');
  } finally { app.dom.window.close(); }
}

/** Repeated activation while the round trip is in flight must collapse into one request. */
async function enterSubmitsOnce(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    const release = app.holdNext('/api/auth/login');
    app.fill(ACCOUNT, PASSWORD);
    app.pressEnter('#lg-pass');
    assert.equal(app.get<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, true, '提交后按钮立即禁用');
    app.pressEnter('#lg-pass');
    app.pressEnter('#lg-pass');
    app.pressEnter('#lg-user');
    // Without the guard each Enter starts its own round trip, so the count is wrong long before
    // the (parked) first request resolves. Check the count first, then let the request through.
    await waitFor(() => app.counts('/api/auth/challenge') >= 1, '挑战请求已发出');
    await wait(150);
    assert.equal(app.counts('/api/auth/challenge'), 1, '连续 Enter 只应发起一次挑战');
    assert.equal(app.counts('/api/auth/login'), 1, '连续 Enter 只应发起一次登录');
    release();
    await waitFor(() => app.editorOpen(), '登录成功后继续编辑');
    await wait(60);

    assert.equal(app.counts('/api/auth/challenge'), 1, '连续 Enter 只应发起一次挑战');
    assert.equal(app.counts('/api/auth/login'), 1, '连续 Enter 只应发起一次登录');
    assert.equal(app.modalOpen(), false, '成功后关闭弹窗');
  } finally { app.dom.window.close(); }
}

/** The happy path: one click, one login, and the caller's continuation runs once. */
async function successfulLoginResumesFlow(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.editorOpen(), '登录成功后继续编辑');
    assert.equal(app.counts('/api/auth/challenge'), 1);
    assert.equal(app.counts('/api/auth/login'), 1);
    assert.equal(app.modalOpen(), false);
    assert.equal(app.get<HTMLTextAreaElement>('#source-editor').value, '<p>指南正文</p>', '编辑区由页面内容填充');

    // The name travels with the challenge answer, and it is the only thing added to the wire.
    const body = app.loginBodies()[0];
    assert.equal(body.user, ACCOUNT, '登录请求应带上用户名');
    assert.equal(typeof body.nonce, 'string', '登录请求应带上 nonce');
    assert.equal(typeof body.proof, 'string', '登录请求应带上证明');
    assert.equal(Object.keys(body).sort().join(','), 'nonce,proof,user', '登录请求只应有这三个字段');
    assert.equal(JSON.stringify(body).includes(PASSWORD), false, '不得将明文密码发往服务器');
  } finally { app.dom.window.close(); }
}

/**
 * A missing name is caught before any request: the server would answer a proof-only login, so an
 * empty field would be blamed on the password. Validation keeps the round trip off the wire.
 */
async function emptyUsernameIsRejectedLocally(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    for (const blank of ['', '   ', '\t\n']) {
      app.fill(blank, PASSWORD);
      app.click('#modal-root [data-x=ok]');
      await wait(60);
      assert.match(app.get('#lg-err').textContent || '', /请输入用户名/, `空用户名应就地报错（${JSON.stringify(blank)}）`);
      assert.equal(app.modalOpen(), true, '空用户名不应关闭弹窗');
      assert.equal(app.editorOpen(), false, '空用户名不得进入编辑');
    }
    assert.equal(app.counts('/api/auth/challenge'), 0, '空用户名不得发起挑战');
    assert.equal(app.counts('/api/auth/login'), 0, '空用户名不得发起登录');
    assert.equal(app.storedUser(), null, '校验失败不写入存储');

    // The same field is still usable: the guard rejects the input, not the dialog.
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.editorOpen(), '补上用户名后继续编辑');
    assert.equal(app.counts('/api/auth/login'), 1);
  } finally { app.dom.window.close(); }
}

/** A name the server could never have stored is refused locally instead of being sent. */
async function invalidUsernameIsRejectedLocally(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    for (const bad of ['测试用户', 'with space', 'symbol!', 'x'.repeat(41)]) {
      app.fill(bad, PASSWORD);
      app.click('#modal-root [data-x=ok]');
      await wait(60);
      assert.match(app.get('#lg-err').textContent || '', /用户名仅限字母、数字、下划线、连字符/, `非法用户名应就地报错（${JSON.stringify(bad)}）`);
      assert.equal(app.modalOpen(), true, '非法用户名不应关闭弹窗');
    }
    assert.equal(app.counts('/api/auth/challenge'), 0, '非法用户名不得发起挑战');
    assert.equal(app.counts('/api/auth/login'), 0, '非法用户名不得发起登录');

    // Surrounding whitespace is not invalid — it is trimmed before it counts.
    app.fill(`  ${ACCOUNT}  `, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.editorOpen(), '去掉空白后继续编辑');
    assert.equal(app.loginBodies()[0].user, ACCOUNT, '用户名应去掉首尾空白后提交');
  } finally { app.dom.window.close(); }
}

/**
 * A wrong name with the right password is refused like a wrong password: the dialog stays up,
 * says so, writes nothing, and the caller's continuation does not run.
 */
async function wrongUsernameIsRejected(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    app.fill('someone-else', PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.counts('/api/auth/login') === 1 && !app.get<HTMLElement>('#lg-err').hidden, '用户名错误被拒');
    assert.match(app.get('#lg-err').textContent || '', /用户名或密码错误/, '用户名错误应提示用户名或密码错误');
    assert.equal(app.modalOpen(), true, '失败后弹窗仍在');
    assert.equal(app.editorOpen(), false, '用户名错误不得进入编辑');
    assert.equal(app.storedUser(), null, '用户名错误不记住用户名');
    assert.equal(app.get<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, false, '失败后应可重试');

    // The wrong attempt sent the name the user typed, together with a valid proof.
    const body = app.loginBodies()[0];
    assert.equal(body.user, 'someone-else', '错误尝试也应提交输入的用户名');
    assert.equal(typeof body.proof, 'string', '错误尝试仍带证明');
    assert.equal(JSON.stringify(body).includes(PASSWORD), false, '不得将明文密码发往服务器');

    // Correcting the name on the same dialog completes the sign-in.
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.editorOpen(), '改正用户名后继续编辑');
    assert.equal(app.counts('/api/auth/login'), 2, '改正后应再发起一次登录');
    assert.equal(app.storedUser(), ACCOUNT, '改对后记住用户名');
  } finally { app.dom.window.close(); }
}

/** A rejected attempt keeps the dialog usable, and a cancel leaves nothing stale behind. */
async function failedAttemptThenReopenIsClean(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    app.fill(ACCOUNT, 'wrong-password');
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.counts('/api/auth/login') === 1, '错误的登录尝试');
    await waitFor(() => !app.get<HTMLElement>('#lg-err').hidden, '显示错误提示');
    assert.match(app.get('#lg-err').textContent || '', /密码错误/);
    const button = app.get<HTMLButtonElement>('#modal-root [data-x=ok]');
    assert.equal(button.disabled, false, '失败后应可重试');
    assert.equal(button.textContent, '登录', '按钮文案应恢复');
    assert.equal(app.editorOpen(), false, '失败不得进入编辑');

    app.click('#modal-root [data-x=no]');
    await waitFor(() => !app.modalOpen(), '取消登录');

    await openFromEditButton(app);
    assert.equal(app.get<HTMLElement>('#lg-err').hidden, true, '重开时不应残留错误');
    assert.equal(app.get<HTMLButtonElement>('#modal-root [data-x=ok]').disabled, false, '重开时按钮可用');
    assert.equal(app.get<HTMLButtonElement>('#modal-root [data-x=ok]').textContent, '登录', '重开时文案正常');
    assert.equal(app.get<HTMLInputElement>('#lg-pass').value, '', '不残留上次的密码');
    assert.equal(app.counts('/api/auth/login'), 1, '重开本身不发起请求');
  } finally { app.dom.window.close(); }
}

/** Setup mode adds a confirmation field; it must be wired to the same guarded submit. */
async function setupModeGuardsAndSyncs(): Promise<void> {
  const app = await createApp({ setupMode: true, path: '/' });
  try {
    await waitFor(() => app.authButton().hidden === false, '首页显示登录入口');
    assert.equal(app.authButton().textContent, '初始化账号');
    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /初始化站长账号/.test(app.modalText()), '初始化弹窗打开');
    assert.ok(app.exists('#lg-pass2'), '初始化时需要确认密码');

    app.get<HTMLInputElement>('#lg-user').value = ACCOUNT;
    app.get<HTMLInputElement>('#lg-pass').value = PASSWORD;
    app.get<HTMLInputElement>('#lg-pass2').value = PASSWORD + '-typo';
    app.pressEnter('#lg-pass2');
    await wait(40);
    assert.match(app.get('#lg-err').textContent || '', /两次输入的密码不一致/);
    assert.equal(app.counts('/api/auth/setup'), 0, '校验失败不得发送请求');

    app.get<HTMLInputElement>('#lg-pass2').value = PASSWORD;
    app.pressEnter('#lg-pass2');
    app.pressEnter('#lg-pass2');
    await waitFor(() => !app.modalOpen(), '创建成功后关闭弹窗');
    await wait(80);
    assert.equal(app.counts('/api/auth/setup'), 1, '连续 Enter 只应创建一次');
    assert.equal(app.calls.find(c => c.url.endsWith('/api/auth/setup'))?.body.ks, expectedKs(), '发送的是真实的派生密钥');
    assert.equal(app.authButton().textContent, '退出', '创建后会话状态同步到界面');
  } finally { app.dom.window.close(); }
}

/**
 * A first, anonymous visit must not be pre-filled from anything: the server only names the
 * account of an existing session, so the field starts empty and the browser may autofill it.
 */
async function anonymousVisitStartsEmpty(): Promise<void> {
  const app = await createApp({ path: '/' });
  try {
    await waitFor(() => app.authButton().hidden === false, '首页显示登录入口');
    assert.equal(app.authButton().textContent, '登录', '未登录时入口是登录');
    assert.equal(app.storedUser(), null, '首次访问不应留下账号记忆');

    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '登录弹窗打开');
    assert.equal(app.get<HTMLInputElement>('#lg-user').value, '', '首次匿名访问不预填用户名');
    assert.equal(app.get<HTMLInputElement>('#lg-pass').value, '', '不预填密码');

    // The anonymous state response must not be able to inject a name either: this one names an
    // account even though nobody is signed in, which is what a server that pre-fills would do.
    const leaked = await createApp({ path: '/', anonUser: 'someone-else' });
    try {
      await waitFor(() => leaked.authButton().hidden === false, '首页显示登录入口');
      leaked.click('#btn-auth');
      await waitFor(() => leaked.modalOpen() && /登录 DocLight/.test(leaked.modalText()), '登录弹窗打开');
      assert.equal(leaked.get<HTMLInputElement>('#lg-user').value, '', '未登录服务端给出的 user 不得预填');
      leaked.click('#modal-root [data-x=no]');
      await waitFor(() => !leaked.modalOpen(), '取消登录');
      assert.equal(leaked.storedUser(), null, '取消登录不写入存储');
    } finally { leaked.dom.window.close(); }

    assert.equal(app.storedUser(), null, '打开弹窗本身也不写入存储');
    app.click('#modal-root [data-x=no]');
    await waitFor(() => !app.modalOpen(), '取消登录');
    assert.equal(app.storedUser(), null, '取消登录不写入存储');
  } finally { app.dom.window.close(); }
}

/** A successful sign-in stores the account name — and nothing else. */
async function successfulLoginRemembersOnlyTheName(): Promise<void> {
  const app = await createApp();
  try {
    await openFromEditButton(app);
    assert.equal(app.get<HTMLInputElement>('#lg-user').value, '', '登录前没有可用的账号记忆');

    // A rejected attempt proves nothing about the name, so it must not be remembered either.
    app.fill(ACCOUNT, 'wrong-password');
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.counts('/api/auth/login') === 1 && !app.get<HTMLElement>('#lg-err').hidden, '登录被拒');
    assert.equal(app.storedUser(), null, '登录失败不记住用户名');

    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.editorOpen(), '登录成功后继续编辑');

    assert.equal(app.storedUser(), 'tester', '成功登录后记住用户名');
    // Anything written must be the name itself: the password, the derived key and the proof are
    // all rejected by this check, whatever key they were filed under.
    const values = app.storedEntries().map(([, value]) => value);
    assert.deepEqual(values.filter(v => v !== 'tester' && v !== 'auto'), [], '不得缓存密码、派生密钥或证明');
    const hexLike = values.filter(value => /^[0-9a-f]{32,}$/i.test(value));
    assert.deepEqual(hexLike, [], '不得缓存派生密钥或 nonce 一类的十六进制串');
  } finally { app.dom.window.close(); }
}

/** Reopening the dialog — or reloading the page — offers the remembered name again. */
async function reopeningPrefillsTheRememberedName(): Promise<void> {
  // The home page keeps the sign-in entry visible, so the whole sign-in → sign-out → sign-in
  // cycle can run without the article view hiding the button.
  const app = await createApp({ path: '/' });
  try {
    await waitFor(() => app.authButton().hidden === false, '首页显示登录入口');
    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '登录弹窗打开');
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => !app.modalOpen() && app.authButton().textContent === '退出', '登录后入口变成退出');
    assert.equal(app.storedUser(), 'tester', '成功登录后记住用户名');

    // Signing out must not forget the name: the login form is precisely what needs it back.
    app.click('#btn-auth');
    await waitFor(() => app.exists('#modal-root [data-x=ok]') && /退出登录/.test(app.modalText()), '退出确认弹出');
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => app.authButton().textContent === '登录', '已退出');
    assert.equal(app.storedUser(), 'tester', '退出登录不清除记住的用户名');

    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '重新弹出登录框');
    assert.equal(app.get<HTMLInputElement>('#lg-user').value, 'tester', '重开时预填记住的用户名');
    assert.equal(app.get<HTMLInputElement>('#lg-pass').value, '', '密码永远不预填');
  } finally { app.dom.window.close(); }

  // A page load that already finds a memory must use it before any request the user makes.
  const seeded = await createApp({ path: '/', stored: { [LOGIN_USER_KEY]: '  tester  ' } });
  try {
    await waitFor(() => seeded.authButton().hidden === false, '首页显示登录入口');
    seeded.click('#btn-auth');
    await waitFor(() => seeded.modalOpen() && /登录 DocLight/.test(seeded.modalText()), '登录弹窗打开');
    assert.equal(seeded.get<HTMLInputElement>('#lg-user').value, 'tester', '重新加载后预填记住的用户名（并去掉首尾空白）');
    assert.equal(seeded.get<HTMLInputElement>('#lg-pass').value, '', '密码永不预填');
    assert.equal(seeded.counts('/api/auth/challenge'), 0, '预填不得依赖服务端挑战');
  } finally { seeded.dom.window.close(); }

  // An empty or unusable memory never pre-fills the field with anything stale.
  for (const stored of ['   ', 'x'.repeat(41)]) {
    const stale = await createApp({ path: '/', stored: { [LOGIN_USER_KEY]: stored } });
    try {
      await waitFor(() => stale.authButton().hidden === false, '首页显示登录入口');
      stale.click('#btn-auth');
      await waitFor(() => stale.modalOpen() && /登录 DocLight/.test(stale.modalText()), '登录弹窗打开');
      assert.equal(stale.get<HTMLInputElement>('#lg-user').value, '', `不可用的记忆不预填（${JSON.stringify(stored.slice(0, 8))}）`);
    } finally { stale.dom.window.close(); }
  }
}

/** Blocked site data must not break sign-in or leave an unusable dialog. */
async function brokenStorageStillSignsIn(): Promise<void> {
  // The home page keeps the sign-in entry visible, so it can be driven without the editor.
  const app = await createApp({ path: '/', storage: 'broken' });
  try {
    // Preferences read before the dialog is even opened must not have thrown the boot away.
    await waitFor(() => app.authButton().hidden === false, '存储不可用时仍能渲染登录入口');
    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /登录 DocLight/.test(app.modalText()), '登录弹窗打开');
    assert.equal(app.get<HTMLInputElement>('#lg-user').value, '', '存储不可用时输入框留空');
    assert.equal(app.get<HTMLInputElement>('#lg-pass').value, '', '密码永不预填');
    app.fill(ACCOUNT, PASSWORD);
    app.click('#modal-root [data-x=ok]');
    await waitFor(() => !app.modalOpen() && app.authButton().textContent === '退出', '存储异常仍能登录');

    assert.equal(app.counts('/api/auth/login'), 1, '存储异常只影响记忆，不影响登录');
    // Asking again must still render a working dialog rather than throw on the failed read.
    app.click('#btn-auth');
    await waitFor(() => app.modalOpen() && /退出登录/.test(app.modalText()), '退出确认照常弹出');
  } finally { app.dom.window.close(); }
}

async function main(): Promise<void> {
  await cancelMidFlightSyncsWithoutResuming();
  await cancelBeforeDispatchSendsNothing();
  await reopeningDoesNotStackEnterHandlers();
  await enterSubmitsOnce();
  await successfulLoginResumesFlow();
  await emptyUsernameIsRejectedLocally();
  await invalidUsernameIsRejectedLocally();
  await wrongUsernameIsRejected();
  await failedAttemptThenReopenIsClean();
  await setupModeGuardsAndSyncs();
  await anonymousVisitStartsEmpty();
  await successfulLoginRemembersOnlyTheName();
  await reopeningPrefillsTheRememberedName();
  await brokenStorageStillSignsIn();
  console.log('login dialog assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
