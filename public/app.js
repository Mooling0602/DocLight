/* ============================================================
   DocLight · app.js — 前端单页应用（无框架）
   v3 空间模型：spaces[] / pages[]（页面归属空间，空间内嵌套）
   ============================================================ */
'use strict';

/* ---------------- 工具函数 ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 && data.needAuth) { S.authed = false; renderAuthUI(); }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function wordCount(html) {
  const box = document.createElement('div');
  box.innerHTML = html || '';
  const text = box.textContent.trim();
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + words;
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^(https?:\/\/|mailto:|#|\/)/i.test(u)) return u;
  return 'https://' + u;
}
function isSafeSrc(u) {
  return /^(https?:\/\/|\/|data:image\/)/i.test(String(u));
}

/* ---------------- 鉴权密码学（http 环境安全设计） ----------------
   密码永不明文上网/落盘：客户端 PBKDF2 派生密钥 ks，服务端只存 ks；
   登录用一次性 nonce 挑战 + HMAC 应答，防重放。
   WebCrypto 不可用时（http 非 localhost）回退到纯 JS 实现。 */
const _te = new TextEncoder();
function hex2b(h) { const r = new Uint8Array(h.length >> 1); for (let i = 0; i < r.length; i++) r[i] = parseInt(h.substr(i * 2, 2), 16); return r; }
function b2hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

function _sha256(bytes) {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const l = bytes.length, bl = l * 8;
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6);
  padded.set(bytes); padded[l] = 0x80;
  const dv0 = new DataView(padded.buffer);
  dv0.setUint32(padded.length - 8, Math.floor(bl / 0x100000000));
  dv0.setUint32(padded.length - 4, bl >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv0.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i-15] >>> 7) | (w[i-15] << 25)) ^ ((w[i-15] >>> 18) | (w[i-15] << 14)) ^ (w[i-15] >>> 3);
      const s1 = ((w[i-2] >>> 17) | (w[i-2] << 15)) ^ ((w[i-2] >>> 19) | (w[i-2] << 13)) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  const out = new Uint8Array(32), dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, H[i]);
  return out;
}
function _concat(a, b) { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
function _hmac(key, msg) {
  if (key.length > 64) key = _sha256(key);
  const ip = new Uint8Array(64).fill(0x36), op = new Uint8Array(64).fill(0x5c);
  key.forEach((b, i) => { ip[i] ^= b; op[i] ^= b; });
  return _sha256(_concat(op, _sha256(_concat(ip, msg))));
}
function _pbkdf2(pw, salt, iters, dkLen) {
  const out = new Uint8Array(dkLen);
  let block = 1, off = 0;
  const u32be = n => { const r = new Uint8Array(4); new DataView(r.buffer).setUint32(0, n); return r; };
  while (off < dkLen) {
    let u = _hmac(pw, _concat(salt, u32be(block)));
    const t = new Uint8Array(u);
    for (let i = 1; i < iters; i++) { u = _hmac(pw, u); for (let j = 0; j < t.length; j++) t[j] ^= u[j]; }
    out.set(t.subarray(0, Math.min(t.length, dkLen - off)), off);
    off += t.length; block++;
  }
  return out;
}
async function deriveKeyHex(pw, saltHex, iters) {
  if (crypto?.subtle) {
    const km = await crypto.subtle.importKey('raw', _te.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: hex2b(saltHex), iterations: iters }, km, 256);
    return b2hex(new Uint8Array(bits));
  }
  return b2hex(_pbkdf2(_te.encode(pw), hex2b(saltHex), iters, 32));
}
async function hmacHex(keyHex, msg) {
  if (crypto?.subtle) {
    const km = await crypto.subtle.importKey('raw', hex2b(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b2hex(new Uint8Array(await crypto.subtle.sign('HMAC', km, _te.encode(msg))));
  }
  return b2hex(_hmac(hex2b(keyHex), _te.encode(msg)));
}

/* ---------------- 全局状态 ---------------- */
const S = {
  spaces: [],         // [{slug,title,desc,home,...}]
  pages: [],          // [{slug,space,parent,title,...}]
  page: null,         // 当前页面详情
  space: null,        // 当前空间（空间索引视图使用）
  dirty: false,
  pendingEdit: null,
  authed: false,
  authSetup: false,
  accountName: null,
  user: null,
  salt: '',
  iters: 0,
};

/* ---------------- 元素引用 ---------------- */
const el = {
  crumb: $('#crumb'),
  clusterView: $('#cluster-view'),
  clusterEdit: $('#cluster-edit'),
  dirtyPill: $('#dirty-pill'),
  btnSave: $('#btn-save'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  list: $('#page-list'),
  search: $('#search'),
  countHint: $('#count-hint'),
  article: $('#article'),
  editWrap: $('#edit-wrap'),
  editor: $('#editor'),
  titleInput: $('#title-input'),
  empty: $('#empty-state'),
  toolbarWrap: $('#toolbar-wrap'),
  modalRoot: $('#modal-root'),
  toasts: $('#toasts'),
};

/* ============================================================
   Toast 提示
   ============================================================ */
let toastTimer;
function toast(msg, ms = 2200) {
  el.toasts.innerHTML = '';
  clearTimeout(toastTimer);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  el.toasts.appendChild(t);
  toastTimer = setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, ms);
}

/* ============================================================
   弹窗（确认 / 输入）
   ============================================================ */
let activeModalDone = null;

function closeModal() {
  el.modalRoot.hidden = true;
  $('.modal', el.modalRoot).innerHTML = '';
  activeModalDone = null;
}

function openModal(innerHTML) {
  el.modalRoot.hidden = false;
  const m = $('.modal', el.modalRoot);
  m.innerHTML = innerHTML;
  const input = $('input', m);
  if (input) { input.focus(); input.select?.(); }
  return m;
}

function confirmModal({ title, desc, ok = '确定', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; closeModal(); resolve(v); } };
    activeModalDone = () => finish(false);
    const m = openModal(`
      <h3>${esc(title)}</h3>
      ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-x="no">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-x="ok">${esc(ok)}</button>
      </div>`);
    $('[data-x=no]', m).onclick = () => finish(false);
    $('[data-x=ok]', m).focus();
    $('[data-x=ok]', m).onclick = () => finish(true);
  });
}

function promptModal({ title, label, value = '', placeholder = '', ok = '确定' }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; closeModal(); resolve(v); } };
    activeModalDone = () => finish(null);
    const m = openModal(`
      <h3>${esc(title)}</h3>
      ${label ? `<p class="desc">${esc(label)}</p>` : ''}
      <input type="text" maxlength="120" value="${esc(value)}" placeholder="${esc(placeholder)}">
      <div class="modal-actions">
        <button class="btn btn-ghost" data-x="no">取消</button>
        <button class="btn btn-primary" data-x="ok">${esc(ok)}</button>
      </div>`);
    const input = $('input', m);
    $('[data-x=no]', m).onclick = () => finish(null);
    $('[data-x=ok]', m).onclick = () => finish(input.value.trim());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(input.value.trim());
    });
  });
}

/* ============================================================
   下拉菜单（主题 / 页面操作 / 行内菜单）
   ============================================================ */
const rowMenu = $('#menu-row');
const menus = [
  { btn: $('#btn-theme'), panel: $('#menu-theme') },
  { btn: $('#btn-more'),  panel: $('#menu-page') },
];

function closeMenus(except) {
  menus.forEach(({ panel }) => { if (panel !== except) panel.hidden = true; });
  if (rowMenu !== except) rowMenu.hidden = true;
}

function openRowMenu(btn, kind, obj) {
  const r = btn.getBoundingClientRect();
  rowMenu.dataset.kind = kind;
  rowMenu.dataset.slug = obj.slug;
  rowMenu.innerHTML = kind === 'space'
    ? `
      <button class="menu-item" data-act="rename"><span>重命名空间…</span></button>
      <button class="menu-item danger" data-act="delete"><span>删除空间…</span></button>`
    : `
      <button class="menu-item" data-act="rename"><span>重命名…</span></button>
      <button class="menu-item" data-act="slug"><span>编辑 slug…</span></button>
      <button class="menu-item" data-act="move"><span>移动到…</span></button>
      <button class="menu-item danger" data-act="delete"><span>删除…</span></button>`;
  rowMenu.hidden = false;
  const mw = 176, mh = kind === 'space' ? 120 : 190;
  rowMenu.style.left = Math.max(8, Math.min(r.left - mw + 12, innerWidth - mw - 8)) + 'px';
  rowMenu.style.top = Math.min(r.bottom + 4, innerHeight - mh - 8) + 'px';
}

// 顶栏下拉按钮的开关切换（主题 / 页面操作）
menus.forEach(({ btn, panel }) => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeMenus(panel);
    panel.hidden = !willOpen;
  });
});

/* ============================================================
   主题：auto / light / dark（跟随系统 + 本地记忆）
   ============================================================ */
const THEME_KEY = 'doclight-theme';
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const themeIcons = { auto: $('#icon-auto'), light: $('#icon-light'), dark: $('#icon-dark') };

function applyTheme(pref) {
  document.documentElement.dataset.themePref = pref;
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
  const dark = pref === 'dark' || (pref === 'auto' && mqDark.matches);
  const root = document.documentElement;
  root.classList.toggle('theme-dark', dark);
  root.classList.toggle('theme-light', !dark);
  Object.entries(themeIcons).forEach(([k, svg]) => {
    svg.hidden = k !== pref;
    svg.style.display = k === pref ? '' : 'none';
  });
  $$('#menu-theme .menu-item').forEach(b =>
    b.setAttribute('aria-checked', b.dataset.pref === pref ? 'true' : 'false'));
}
mqDark.addEventListener('change', () => {
  if ((document.documentElement.dataset.themePref || 'auto') === 'auto') applyTheme('auto');
});
$$('#menu-theme .menu-item').forEach(b =>
  b.addEventListener('click', () => { applyTheme(b.dataset.pref); closeMenus(null); }));

let savedPref = 'auto';
try { savedPref = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* ignore */ }
applyTheme(savedPref);

/* ============================================================
   鉴权状态（服务端 = 唯一事实源）
   ============================================================ */
async function refreshAuthState() {
  try {
    const st = await api('auth/state');
    S.authSetup = st.mode === 'setup';
    S.authed = !!st.authed;
    S.user = st.authed ? (st.user || null) : null;
    S.accountName = st.user || null;
    S.salt = st.salt; S.iters = st.iters;
  } catch { /* 网络异常时保留旧状态 */ }
  renderAuthUI();
}

function renderAuthUI() {
  const b = $('#btn-auth');
  b.hidden = !!S.page || !!S.space;   // 文章页/编辑态不显示
  if (b.hidden) return;
  b.textContent = S.authed ? '退出' : (S.authSetup ? '初始化账号' : '登录');
  b.title = S.authed ? `${S.user} · 退出登录`
    : (S.authSetup ? '首次使用，先设置站长账号' : '登录（修改内容需要）');
  b.onclick = () => {
    if (!S.authed) { showLoginDialog({ setup: S.authSetup }); return; }
    confirmModal({ title: `退出登录（${S.user}）？`, ok: '退出' }).then(async yes => {
      if (!yes) return;
      try { await api('auth/logout', { method: 'POST' }); } catch { /* ignore */ }
      await refreshAuthState();
      toast('已退出');
      if (!el.editWrap.hidden) tryCancelEdit();
    });
  };
}

function showLoginDialog({ setup = false, then } = {}) {
  const m = openModal(`
    <h3>${setup ? '初始化站长账号' : '登录 DocLight'}</h3>
    <p class="desc">${setup
      ? '首次使用，设置用户名与密码。密码经 PBKDF2 派生，明文不落盘、不上网。用户名仅限字母、数字、_ 或 -。'
      : '修改内容前需要登录（阅读始终公开）。'}</p>
    <input id="lg-user" type="text" placeholder="${setup ? '请设置用户名' : '请输入用户名'}" maxlength="40" autocomplete="username" value="${setup ? '' : esc(S.accountName || S.user || '')}">
    <input id="lg-pass" type="password" placeholder="密码" autocomplete="${setup ? 'new-password' : 'current-password'}">
    ${setup ? '<input id="lg-pass2" type="password" placeholder="确认密码" autocomplete="new-password">' : ''}
    <p class="desc" id="lg-err" style="color:var(--danger)" hidden></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-x="no">取消</button>
      <button class="btn btn-primary" data-x="ok">${setup ? '创建并登录' : '登录'}</button>
    </div>`);
  const $lg = s => $(s, m);
  const err = t => { const e = $lg('#lg-err'); e.textContent = t; e.hidden = !t; };
  const okBtn = $lg('[data-x=ok]');
  const submit = async () => {
    const user = $lg('#lg-user').value.trim();
    const pass = $lg('#lg-pass').value;
    if (setup && !/^[A-Za-z0-9_-]{1,40}$/.test(user)) { err('用户名仅限字母、数字、下划线、连字符（≤40 位）'); return; }
    if (!/^[\x20-\x7E]+$/.test(pass)) { err('密码仅支持英文、数字与半角符号，不能包含中文或全角字符'); return; }
    if (pass.length < 6) { err('密码长度至少 6 位'); return; }
    if (setup && pass !== $lg('#lg-pass2').value) { err('两次输入的密码不一致'); return; }
    okBtn.disabled = true; okBtn.textContent = '验证中…'; err('');
    try {
      if (setup) {
        const ks = await deriveKeyHex(pass, S.salt, S.iters);
        await api('auth/setup', { method: 'POST', body: JSON.stringify({ user, ks }) });
      } else {
        const ch = await api('auth/challenge');
        const k = await deriveKeyHex(pass, ch.salt, ch.iters);
        const proof = await hmacHex(k, ch.nonce);
        await api('auth/login', { method: 'POST', body: JSON.stringify({ nonce: ch.nonce, proof }) });
      }
      await refreshAuthState();
      closeModal();
      toast(setup ? '账号已创建 ✓' : `欢迎回来，${S.user}`);
      then?.();
    } catch (e2) {
      err(e2.message || '操作失败');
      okBtn.disabled = false; okBtn.textContent = setup ? '创建并登录' : '登录';
    }
  };
  $('[data-x=no]', m).onclick = () => closeModal();
  okBtn.onclick = submit;
  activeModalDone = () => closeModal();
  m.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $lg('#lg-user').focus();
}

/* ============================================================
   层级计算（空间 → 页面树）
   ============================================================ */
function spaceBySlug(slug) { return S.spaces.find(s => s.slug === slug) || null; }
function pageBySlug(slug) { return S.pages.find(p => p.slug === slug) || null; }
function spacePages(spaceSlug, parent = null) {
  return S.pages.filter(p => p.space === spaceSlug && (p.parent || null) === parent);
}
function childrenOf(parentSlug) { return S.pages.filter(p => (p.parent || null) === parentSlug); }
function chainOf(pageSlug) {
  const page = pageBySlug(pageSlug);
  if (!page) return [];
  const space = spaceBySlug(page.space);
  const chain = [];
  let cur = page;
  while (cur) { chain.unshift(cur); cur = cur.parent ? pageBySlug(cur.parent) : null; }
  return space ? [space, ...chain] : chain;
}
function canonicalPath(slug) {
  if (spaceBySlug(slug)) return '/' + encodeURIComponent(slug);
  return '/' + chainOf(slug).map(n => encodeURIComponent(n.slug)).join('/');
}
function descendantSlugsOf(slug) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of S.pages) {
      if (p.parent && !out.has(p.slug) && (out.has(p.parent) || p.parent === slug)) { out.add(p.slug); grew = true; }
    }
  }
  return out;
}

const COLLAPSE_KEY = 'doclight-collapsed';
let collapsedSet = new Set();
try { collapsedSet = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { /* ignore */ }

// 导航到某页面时自动展开其空间与祖先链（仅导航时机调用，手动折叠不会被覆盖）
function revealPath(pageSlug) {
  const page = pageBySlug(pageSlug);
  if (!page) return;
  collapsedSet.delete('s:' + page.space);
  let cur = page;
  while (cur) { collapsedSet.delete('p:' + cur.slug); cur = cur.parent ? pageBySlug(cur.parent) : null; }
}

/* ============================================================
   侧栏：空间分区 + 页面树
   ============================================================ */
function renderSidebar(filter = '') {
  const q = filter.trim().toLowerCase();
  el.list.innerHTML = '';

  if (q) {
    const items = S.pages.filter(p => p.title.toLowerCase().includes(q));
    if (!items.length) el.list.innerHTML = '<div class="list-empty">没有匹配的文档</div>';
    items.forEach(p => {
      const sp = spaceBySlug(p.space);
      const chain = chainOf(p.slug).slice(1, -1).map(x => x.title).join(' / ');
      const a = document.createElement('a');
      a.className = 'page-item' + (S.page?.slug === p.slug ? ' active' : '');
      a.href = canonicalPath(p.slug);
      a.dataset.nav = '';
      a.innerHTML = `<span class="t">${esc(p.title)}</span><span class="s">${esc(sp?.title || '')}${chain ? ' / ' + esc(chain) + ' · ' : ' · '}${relTime(p.updatedAt)}</span>`;
      el.list.appendChild(a);
    });
    el.countHint.textContent = `匹配 ${items.length} 页`;
    return;
  }

  if (!S.pages.length && !S.spaces.length) {
    el.list.innerHTML = '<div class="list-empty">暂无内容，点击上方按钮创建空间</div>';
    el.countHint.textContent = '空';
    return;
  }

  const activeSpace = S.page?.space || S.space?.slug || null;

  S.spaces.forEach(space => {
    const tops = spacePages(space.slug, null);
    const isOpen = !collapsedSet.has('s:' + space.slug); // 手动折叠永远获胜

    const head = document.createElement('div');
    head.className = 'space-row' + (activeSpace === space.slug ? ' is-active' : '');

    const caret = document.createElement('button');
    caret.className = 'caret' + (isOpen ? ' open' : '');
    caret.hidden = !tops.length;
    caret.title = isOpen ? '折叠空间' : '展开空间';
    caret.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    caret.addEventListener('click', () => {
      collapsedSet.has('s:' + space.slug) ? collapsedSet.delete('s:' + space.slug) : collapsedSet.add('s:' + space.slug);
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedSet])); } catch { /* ignore */ }
      renderSidebar(el.search.value);
    });

    const t = document.createElement('a');
    t.className = 'space-title';
    t.href = '/' + encodeURIComponent(space.slug);
    t.dataset.nav = '';
    t.innerHTML = `<span class="t">${esc(space.title)}</span><span class="s">${tops.length} 页</span>`;

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'ra-btn';
    addBtn.title = '在此空间新建页面';
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    addBtn.addEventListener('click', ev => { ev.stopPropagation(); createPageFlow(space.slug, null); });
    const moreBtn = document.createElement('button');
    moreBtn.className = 'ra-btn';
    moreBtn.title = '空间管理';
    moreBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><g fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></g></svg>';
    moreBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const toggleShut = !rowMenu.hidden && rowMenu.dataset.slug === space.slug;
      closeMenus(rowMenu);
      if (toggleShut) rowMenu.hidden = true;
      else openRowMenu(moreBtn, 'space', space);
    });
    actions.append(addBtn, moreBtn);

    head.append(caret, t, actions);
    el.list.appendChild(head);

    if (isOpen) {
      const box = document.createElement('div');
      const build = (parent, depth) => {
        spacePages(space.slug, parent).forEach(p => {
          const kids = childrenOf(p.slug).filter(k => k.space === space.slug);
          const pOpen = !collapsedSet.has('p:' + p.slug);

          const row = document.createElement('div');
          row.className = 'tree-row';

          const pc = document.createElement('button');
          pc.className = 'caret' + (pOpen ? ' open' : '');
          pc.hidden = !kids.length;
          pc.title = pOpen ? '折叠' : '展开';
          pc.innerHTML = caret.innerHTML;
          pc.addEventListener('click', () => {
            collapsedSet.has('p:' + p.slug) ? collapsedSet.delete('p:' + p.slug) : collapsedSet.add('p:' + p.slug);
            try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedSet])); } catch { /* ignore */ }
            renderSidebar(el.search.value);
          });

          const a = document.createElement('a');
          a.className = 'page-item' + (S.page?.slug === p.slug ? ' active' : '');
          a.href = canonicalPath(p.slug);
          a.dataset.nav = '';
          a.style.paddingLeft = (10 + depth * 16) + 'px';
          a.innerHTML = `<span class="t">${esc(p.title)}</span><span class="s">${relTime(p.updatedAt)}${kids.length ? ' · ' + kids.length + ' 子页' : ''}</span>`;

          const acts = document.createElement('span');
          acts.className = 'row-actions';
          const pa = document.createElement('button');
          pa.className = 'ra-btn';
          pa.title = '新建子页面';
          pa.innerHTML = addBtn.innerHTML;
          pa.addEventListener('click', ev => { ev.stopPropagation(); createPageFlow(space.slug, p.slug); });
          const pm = document.createElement('button');
          pm.className = 'ra-btn';
          pm.title = '更多操作';
          pm.innerHTML = moreBtn.innerHTML;
          pm.addEventListener('click', ev => {
            ev.stopPropagation();
            const toggleShut = !rowMenu.hidden && rowMenu.dataset.slug === p.slug;
            closeMenus(rowMenu);
            if (toggleShut) rowMenu.hidden = true;
            else openRowMenu(pm, 'page', p);
          });
          acts.append(pa, pm);

          row.append(pc, a, acts);
          if (S.page?.slug === p.slug) row.classList.add('is-active');
          box.appendChild(row);

          if (kids.length && pOpen) build(p.slug, depth + 1);
        });
      };
      build(null, 0);
      el.list.appendChild(box);
    }
  });

  el.countHint.textContent = `${S.spaces.length} 空间 · ${S.pages.length} 页`;
}

el.search.addEventListener('input', () => renderSidebar(el.search.value));

/* ============================================================
   阅读视图渲染
   ============================================================ */
function decorate(container) {
  container.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  container.querySelectorAll('img').forEach(img => img.loading = 'lazy');
  // h2/h3 悬停出现标签式锚点，点击复制干净的小节链接（/路径#h-x）
  container.querySelectorAll('h2, h3').forEach((h, i) => {
    h.id = 'h-' + i;
    const a = document.createElement('a');
    a.className = 'heading-anchor';
    a.title = '复制本节链接';
    a.href = 'javascript:void 0';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3.5 12.6l7.9 7.9a2 2 0 0 0 2.8 0l6.3-6.3a2 2 0 0 0 .6-1.7l-.6-5.6a2 2 0 0 0-1.8-1.8l-5.6-.6a2 2 0 0 0-1.7.6l-7.9 7.9a2 2 0 0 0 0 2.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15.3" cy="8.7" r="1.5" fill="currentColor"/></svg>';
    a.addEventListener('click', ev => {
      ev.preventDefault();
      history.replaceState(null, '', '#' + h.id);
      const link = location.origin + location.pathname + '#' + h.id;
      (navigator.clipboard?.writeText(link) ?? Promise.reject())
        .then(() => toast('小节链接已复制'))
        .catch(() => toast('复制失败，请手动复制'));
    });
    h.appendChild(a);
  });
  if (location.hash.startsWith('#h-')) {
    const t = container.querySelector('#' + CSS.escape(location.hash.slice(1)));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderArticle(page) {
  const chain = chainOf(page.slug);
  const crumbsHtml = chain.map((n, i) =>
    n === chain[chain.length - 1]
      ? `<span class="cur">${esc(n.title)}</span>`
      : `<a href="${canonicalPath(n.slug)}" data-nav>${esc(n.title)}</a>`
  ).join('<span class="sep">/</span>');

  el.article.innerHTML =
    `<div class="meta-row">
       <nav class="crumbs">${crumbsHtml}</nav><span class="sep">·</span>
       <span>更新于 ${relTime(page.updatedAt)}</span><span class="sep">·</span>
       <span>${wordCount(page.content)} 字</span><span class="sep">·</span>
       <a href="javascript:void 0" id="copy-link">复制页面链接</a><span class="sep">·</span>
       <a href="javascript:void 0" id="slug-edit" class="slug-chip" title="编辑链接 slug">#${esc(page.slug)}</a>
     </div>` + page.content;

  decorate(el.article);
  $('#copy-link').addEventListener('click', () => {
    (navigator.clipboard?.writeText(location.href) ?? Promise.reject())
      .then(() => toast('页面链接已复制'))
      .catch(() => toast('复制失败'));
  });
  $('#slug-edit').addEventListener('click', () => slugFlow(S.page));

  const crumbText = chain.map(n => n.title).join(' / ');
  el.crumb.textContent = crumbText.length > 26 ? crumbText.slice(0, 26) + '…' : crumbText;
  document.title = page.title + ' · DocLight';

  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.empty.hidden = true;
  el.article.hidden = false;
  el.clusterEdit.hidden = true;
  el.clusterView.hidden = false;
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  renderAuthUI();
  renderSidebar(el.search.value);
}

/* ============================================================
   编辑器核心
   ============================================================ */
function markDirty() {
  if (!S.dirty) { S.dirty = true; el.dirtyPill.hidden = false; }
}

function placeCaretEnd(node) {
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function enterEdit(focus = true) {
  if (!S.page) return;
  S.dirty = false;
  el.article.hidden = true;
  el.empty.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = false;
  el.toolbarWrap.hidden = false;
  el.editWrap.hidden = false;
  el.titleInput.value = S.page.title;
  el.editor.innerHTML = S.page.content || '';
  if (focus) placeCaretEnd(el.editor);
  setTimeout(() => refreshToolbarState(), 50);
}

async function exitEdit(reloadFromPage) {
  if (reloadFromPage && S.page) {
    try { S.page = await api('pages/' + encodeURIComponent(S.page.slug)); } catch { /* keep */ }
  }
  S.dirty = false;
  if (S.page) renderArticle(S.page);
}

async function saveDoc() {
  if (!S.page) return;
  if (!S.dirty) { await exitEdit(false); return; }
  const title = el.titleInput.value.trim() || '无标题页面';
  const content = el.editor.innerHTML;
  el.btnSave.disabled = true;
  try {
    const updated = await api('pages/' + encodeURIComponent(S.page.slug), {
      method: 'PUT',
      body: JSON.stringify({ title, content }),
    });
    S.page = updated;
    const i = S.pages.findIndex(p => p.slug === updated.slug);
    if (i >= 0) { S.pages[i].title = updated.title; S.pages[i].updatedAt = updated.updatedAt; }
    S.dirty = false;
    el.dirtyPill.hidden = true;
    toast('已保存 ✓');
    await exitEdit(false);
    renderSidebar(el.search.value);
  } catch (err) {
    toast(err.message || '保存失败', 3000);
  } finally {
    el.btnSave.disabled = false;
  }
}

async function tryCancelEdit() {
  if (S.dirty) {
    const go = await confirmModal({
      title: '放弃未保存的修改？',
      desc: '本次编辑的内容将不会被保存。',
      ok: '放弃修改',
      danger: true,
    });
    if (!go) return;
  }
  await exitEdit(true);
}

/* ============================================================
   富文本命令
   ============================================================ */
function exec(cmd, val = null) {
  document.execCommand(cmd, false, val);
  markDirty();
  refreshToolbarState();
  el.editor.focus();
}

function currentBlockTag() {
  let n = getSelection()?.anchorNode;
  while (n && n !== el.editor) {
    if (n.nodeType === 1 && /^(H1|H2|H3|P|PRE|BLOCKQUOTE)$/.test(n.tagName)) return n.tagName;
    n = n.parentNode;
  }
  return null;
}

function refreshToolbarState() {
  if (el.editWrap.hidden) return;
  const states = ['bold', 'italic', 'underline', 'strikeThrough',
                  'insertUnorderedList', 'insertOrderedList',
                  'justifyLeft', 'justifyCenter', 'justifyRight'];
  $$('#toolbar [data-state]').forEach(b => {
    let on = false;
    try { on = document.queryCommandState(b.dataset.state); } catch { /* ignore */ }
    b.classList.toggle('active', on);
  });
  const tag = currentBlockTag();
  $$('#toolbar [data-block]').forEach(b =>
    b.classList.toggle('active', !!tag && b.dataset.block === tag));
}

document.addEventListener('selectionchange', () => {
  if (!el.editWrap.hidden) requestAnimationFrame(refreshToolbarState);
});

function surroundInlineCode() {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const selected = range.toString();

  if (!selected.trim()) {
    document.execCommand('insertHTML', false, '<code>&nbsp;</code>');
  } else if (range.startContainer.parentElement.closest('code')) {
    const codeEl = range.startContainer.parentElement.closest('code');
    codeEl.replaceWith(...codeEl.childNodes);
  } else {
    const frag = range.extractContents();
    const code = document.createElement('code');
    code.appendChild(frag);
    range.insertNode(code);
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(code);
    sel.addRange(r);
  }
  markDirty();
}

async function cmdLink() {
  el.editor.focus();
  const sel = getSelection();
  const text = sel.rangeCount ? sel.getRangeAt(0).toString() : '';
  const existing = sel.rangeCount && sel.anchorNode?.parentElement?.closest('a');
  const url = await promptModal({
    title: '插入链接',
    label: text ? `将为「${text.slice(0, 24)}」添加超链接` : '选中文本后再点击工具栏，可直接给文字加链接',
    value: existing?.getAttribute('href') || '',
    placeholder: 'https://example.com',
    ok: '插入',
  });
  if (url === null) return;
  const finalUrl = normalizeUrl(url);
  if (!finalUrl) { toast('请输入有效的链接地址'); return; }
  if (existing) {
    existing.setAttribute('href', finalUrl);
  } else if (text.trim()) {
    document.execCommand('createLink', false, esc(finalUrl));
    const a = sel.anchorNode?.parentElement?.closest('a');
    if (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  } else {
    document.execCommand('insertHTML', false,
      `<a href="${esc(finalUrl)}" target="_blank" rel="noopener noreferrer">${esc(finalUrl)}</a>&nbsp;`);
  }
  markDirty();
}

async function cmdImage() {
  const url = await promptModal({
    title: '插入图片',
    label: '支持 http(s) 与 data:image 地址',
    placeholder: 'https://…/image.png',
    ok: '插入',
  });
  if (url === null) return;
  if (!isSafeSrc(normalizeUrl(url))) { toast('仅支持 http(s) 图片地址'); return; }
  document.execCommand('insertHTML', false, `<img src="${esc(normalizeUrl(url))}" alt="">`);
  markDirty();
}

/* 清除格式：选区内段落转正文 + 剥除全部行内样式与对齐（代码块保留） */
function clearFormatting() {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const orig = sel.getRangeAt(0);

  document.execCommand('removeFormat', false, null);
  document.execCommand('unlink', false, null);

  const codes = [];
  const walker = document.createTreeWalker(el.editor, NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => (n.tagName === 'CODE' && !n.closest('pre') && orig.intersectsNode(n))
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) codes.push(walker.currentNode);
  codes.forEach(c => c.replaceWith(...c.childNodes));

  $$('h1, h2, h3, blockquote, p', el.editor).forEach(b => {
    if (!orig.intersectsNode(b)) return;
    if (/^(H1|H2|H3|BLOCKQUOTE)$/.test(b.tagName)) {
      const r = document.createRange();
      r.selectNodeContents(b);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('formatBlock', false, 'p');
    }
    document.execCommand('justifyLeft', false, null);
  });

  try {
    sel.removeAllRanges();
    const rr = document.createRange();
    rr.setStart(orig.startContainer, orig.startOffset);
    rr.collapse(true);
    sel.addRange(rr);
  } catch { placeCaretEnd(el.editor); }

  markDirty();
  refreshToolbarState();
}

/* 粘贴清理：保留语义标签，剥离脚本与内联垃圾 */
function cleanPastedHtml(html) {
  const ALLOW = new Set(['P','BR','B','STRONG','I','EM','U','S','STRIKE','DEL',
                         'UL','OL','LI','A','IMG','BLOCKQUOTE','PRE','CODE','HR',
                         'H1','H2','H3','H4','DIV']);
  const box = document.createElement('div');
  box.innerHTML = String(html);

  const walk = node => {
    [...node.children].forEach(child => {
      walk(child);
      if (!ALLOW.has(child.tagName)) { child.replaceWith(...child.childNodes); return; }
      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase(), val = attr.value;
        if (name === 'href' && /^https?:|^#/i.test(val)) return;
        if (name === 'src' && isSafeSrc(val)) return;
        if (name === 'alt') return;
        child.removeAttribute(attr.name);
      });
    });
  };
  walk(box);
  return box.innerHTML;
}

el.editor.addEventListener('paste', e => {
  e.preventDefault();
  const clip = e.clipboardData;
  const html = clip.getData('text/html');
  if (html) {
    document.execCommand('insertHTML', false, cleanPastedHtml(html));
  } else {
    document.execCommand('insertText', false, clip.getData('text/plain'));
  }
  markDirty();
});

el.editor.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const inPre = getSelection()?.anchorNode?.parentElement?.closest('pre');
  if (inPre) {
    document.execCommand('insertText', false, '    ');
  } else if (e.shiftKey) {
    document.execCommand('outdent');
  } else {
    document.execCommand('indent');
  }
  markDirty();
});

/* 工具栏事件分发 */
let touchTriggered = false;
$('#toolbar').addEventListener('pointerdown', e => { touchTriggered = e.pointerType !== 'mouse'; });
$('#toolbar').addEventListener('touchstart', () => { touchTriggered = true; }, { passive: true });
$('#toolbar').addEventListener('mousedown', e => e.preventDefault());
$('#toolbar').addEventListener('click', async e => {
  const btn = e.target.closest('.tbtn');
  if (!btn) return;
  if (touchTriggered) {
    touchTriggered = false;
    const tip = btn.title;
    if (tip) toast(tip, 1400);
  }
  const cmd = btn.dataset.cmd;
  el.editor.focus();

  switch (cmd) {
    case 'inlinecode': surroundInlineCode(); break;
    case 'createlink': await cmdLink(); break;
    case 'insertimage': await cmdImage(); break;
    case 'removeFormat': clearFormatting(); break;
    case 'formatBlock': {
      const cur = currentBlockTag();
      const target = cur && cur === btn.dataset.block.toUpperCase() ? 'p' : btn.dataset.val;
      exec('formatBlock', target);
      break;
    }
    default: exec(cmd, btn.dataset.val || null);
  }
});

/* ============================================================
   空间操作
   ============================================================ */
async function createSpaceFlow() {
  const title = await promptModal({
    title: '新建空间',
    label: '空间是一组文档的容器（例如：产品手册、团队博客）。创建后可在其中自由嵌套页面。',
    placeholder: '例如：产品手册',
    ok: '创建',
  });
  if (title === null) return;
  if (!title) { toast('空间名称不能为空'); return; }
  try {
    const space = await api('spaces', { method: 'POST', body: JSON.stringify({ title }) });
    S.spaces.push(space);
    toast('空间已创建 ✓');
    navigate('/' + encodeURIComponent(space.slug));
  } catch (err) { toast(err.message, 3000); }
}

async function renameSpaceFlow(space) {
  if (!space) return;
  const title = await promptModal({ title: '重命名空间', value: space.title, ok: '保存' });
  if (title === null || !title || title === space.title) return;
  try {
    const updated = await api('spaces/' + encodeURIComponent(space.slug), {
      method: 'PUT', body: JSON.stringify({ title }),
    });
    const i = S.spaces.findIndex(s => s.slug === space.slug);
    if (i >= 0) S.spaces[i] = updated;
    if (S.space?.slug === space.slug) { S.space = updated; renderSpace(updated); }
    else if (S.page?.space === space.slug) renderArticle(S.page);
    else renderSidebar(el.search.value);
    toast('空间已重命名 ✓');
  } catch (err) { toast(err.message, 3000); }
}

async function deleteSpaceFlow(space) {
  if (!space) return;
  const count = S.pages.filter(p => p.space === space.slug).length;
  const go = await confirmModal({
    title: `删除空间「${space.title}」？`,
    desc: count ? `空间内 ${count} 个页面将一并删除，且无法恢复。` : '删除后无法恢复。',
    ok: '删除空间',
    danger: true,
  });
  if (!go) return;
  try {
    const r = await api('spaces/' + encodeURIComponent(space.slug), { method: 'DELETE' });
    S.pages = S.pages.filter(p => p.space !== space.slug);
    S.spaces = S.spaces.filter(s => s.slug !== space.slug);
    toast(r.removedPages.length ? `已删除空间及 ${r.removedPages.length} 个页面` : '已删除空间');
    if (S.page && S.page.space === space.slug) { S.page = null; navigate('/'); }
    else if (S.space?.slug === space.slug) { S.space = null; navigate('/'); }
    else { renderSidebar(el.search.value); renderAuthUI(); }
  } catch (err) { toast(err.message, 3000); }
}

/* ============================================================
   页面操作
   ============================================================ */
async function createPageFlow(spaceSlug, parent = null) {
  const title = await promptModal({
    title: parent ? '新建子页面' : '新建页面',
    label: '输入标题即可，稍后可随时修改。链接地址将由标题自动生成并永久固定。',
    placeholder: '例如：产品设计规范',
    ok: '创建',
  });
  if (title === null) return;
  if (!title) { toast('标题不能为空'); return; }
  try {
    const page = await api('pages', {
      method: 'POST',
      body: JSON.stringify({ title, space: spaceSlug, parent }),
    });
    S.pages.push({ ...page });
    toast('已创建，开始编辑吧');
    S.pendingEdit = page.slug;
    navigate(canonicalPath(page.slug));
  } catch (err) { toast(err.message, 3000); }
}

async function renameFlow(pg = S.page) {
  if (!pg) return;
  const title = await promptModal({ title: '重命名页面', value: pg.title, ok: '保存' });
  if (title === null || !title || title === pg.title) return;
  try {
    await api('pages/' + encodeURIComponent(pg.slug), {
      method: 'PUT', body: JSON.stringify({ title }),
    });
    const i = S.pages.findIndex(p => p.slug === pg.slug);
    if (i >= 0) S.pages[i].title = title;
    if (S.page?.slug === pg.slug) { S.page.title = title; renderArticle(S.page); }
    else if (S.space) renderSpace(S.space);
    else renderSidebar(el.search.value);
    toast('已重命名 ✓');
  } catch (err) { toast(err.message, 3000); }
}

async function slugFlow(pg = S.page) {
  if (!pg) return;
  const value = await promptModal({
    title: '编辑链接 slug',
    label: '仅限小写字母、数字、下划线。slug 是页面的永久地址，修改后旧链接将失效（免费随便改 🙂）',
    value: pg.slug,
    placeholder: 'my_page_1',
    ok: '保存',
  });
  if (value === null || value === pg.slug) return;
  const ns = value.trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  if (!ns) { toast('slug 只能含小写字母、数字、下划线'); return; }
  try {
    const old = pg.slug;
    const updated = await api('pages/' + encodeURIComponent(old), {
      method: 'PUT', body: JSON.stringify({ slug: ns }),
    });
    S.pages.forEach(p => { if (p.parent === old) p.parent = ns; });
    const i = S.pages.findIndex(p => p.slug === old);
    if (i >= 0) { S.pages[i].slug = ns; S.pages[i].updatedAt = updated.updatedAt; }
    toast('slug 已更新 ✓');
    if (S.page?.slug === old) { S.page = updated; navigate(canonicalPath(ns)); }
    else if (S.space) renderSpace(S.space);
    else renderSidebar(el.search.value);
  } catch (err) { toast(err.message, 3000); }
}

async function moveFlow(pg = S.page) {
  if (!pg) return;
  const banned = new Set([pg.slug, ...descendantSlugsOf(pg.slug)]);
  const options = [];
  S.spaces.forEach(sp => {
    options.push({ v: 's:' + sp.slug, label: '📁 ' + sp.title + '（顶层）' });
    const walk = (parent, depth) => {
      spacePages(sp.slug, parent).forEach(p => {
        if (banned.has(p.slug)) return;
        options.push({ v: 'p:' + p.slug, label: '　'.repeat(depth + 1) + '└ ' + p.title });
        walk(p.slug, depth + 1);
      });
    };
    walk(null, 0);
  });
  const current = pg.parent ? 'p:' + pg.parent : 's:' + pg.space;
  const m = openModal(`
    <h3>移动「${esc(pg.title)}」</h3>
    <p class="desc">可选择目标空间（顶层）或空间内的某个页面（其子页面）。URL 会随新位置变化，旧链接自动规范化跳转。</p>
    <select id="move-select">${options.map(o =>
      `<option value="${esc(o.v)}"${o.v === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-x="no">取消</button>
      <button class="btn btn-primary" data-x="ok">移动</button>
    </div>`);
  const sel = $('#move-select', m);
  let settled = false;
  const finish = async proceed => {
    if (settled) return;
    settled = true;
    const pick = sel.value || '';
    closeModal();
    if (!proceed) return;
    const toSpace = pick.startsWith('s:') ? pick.slice(2) : pg.space;
    const toParent = pick.startsWith('p:') ? pick.slice(2) : null;
    if (toSpace === pg.space && toParent === (pg.parent || null)) { toast('位置未变化'); return; }
    try {
      const updated = await api('pages/' + encodeURIComponent(pg.slug), {
        method: 'PUT', body: JSON.stringify({ space: toSpace, parent: toParent }),
      });
      const i = S.pages.findIndex(p => p.slug === pg.slug);
      if (i >= 0) { S.pages[i].space = updated.space; S.pages[i].parent = updated.parent; }
      toast('已移动 ✓');
      if (S.page?.slug === pg.slug) { S.page = updated; navigate(canonicalPath(pg.slug)); }
      else { renderSidebar(el.search.value); if (S.space) renderSpace(S.space); }
    } catch (err) { toast(err.message, 3000); }
  };
  $('[data-x=no]', m).onclick = () => finish(false);
  $('[data-x=ok]', m).onclick = () => finish(true);
  activeModalDone = () => finish(false);
}

async function deleteFlow(pg = S.page) {
  if (!pg) return;
  const kidCount = descendantSlugsOf(pg.slug).size;
  const go = await confirmModal({
    title: `删除「${pg.title}」？`,
    desc: kidCount ? `将连带删除其下 ${kidCount} 个子页面，删除后无法恢复。` : '删除后无法恢复。',
    ok: '删除',
    danger: true,
  });
  if (!go) return;
  try {
    await api('pages/' + encodeURIComponent(pg.slug), { method: 'DELETE' });
    const doomed = new Set([pg.slug, ...descendantSlugsOf(pg.slug)]);
    S.pages = S.pages.filter(p => !doomed.has(p.slug));
    toast(kidCount ? `已删除 ${kidCount + 1} 个页面` : '已删除');
    if (S.page && doomed.has(S.page.slug)) { S.page = null; navigate('/'); }
    else {
      if (S.space) renderSpace(S.space);
      else if (S.page) renderArticle(S.page);
      renderSidebar(el.search.value);
    }
  } catch (err) { toast(err.message, 3000); }
}

/* ============================================================
   视图：空间总览 / 空间索引 / 文章
   ============================================================ */
function renderHome() {
  S.page = null; S.space = null;
  document.title = 'DocLight · 空间总览';
  el.crumb.textContent = '';
  el.article.hidden = true;
  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = true;
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  if (!S.spaces.length) {
    el.article.hidden = true;
    el.empty.hidden = false;
    renderAuthUI();
    renderSidebar(el.search.value);
    return;
  }
  el.empty.hidden = true;

  const cards = S.spaces.map(sp => {
    const n = S.pages.filter(p => p.space === sp.slug).length;
    return `<a class="card" data-nav href="/${encodeURIComponent(sp.slug)}">
              <span class="t">${esc(sp.title)}</span>
              ${sp.desc ? `<span class="d">${esc(sp.desc)}</span>` : ''}
              <span class="s">${n ? n + ' 个页面 · ' : ''}更新于 ${relTime(sp.updatedAt)}</span>
            </a>`;
  }).join('');
  el.article.innerHTML =
    `<div class="overview-head"><h1>空间</h1>
       <button class="btn btn-new" id="btn-home-new">＋ 新建空间</button></div>
     <div class="cards">${cards}</div>`;
  el.article.hidden = false;
  decorate(el.article);
  $('#btn-home-new').addEventListener('click', createSpaceFlow);
  renderAuthUI();
  renderSidebar(el.search.value);
}

function renderSpace(space) {
  S.page = null; S.space = space;
  collapsedSet.delete('s:' + space.slug);   // 进入空间索引时展开
  document.title = space.title + ' · DocLight';
  el.crumb.textContent = space.title;
  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.empty.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = true;
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  const tops = spacePages(space.slug, null);
  const cards = tops.map(p => {
    const n = childrenOf(p.slug).filter(k => k.space === space.slug).length;
    return `<a class="card" data-nav href="${canonicalPath(p.slug)}">
              <span class="t">${esc(p.title)}</span>
              <span class="s">${n ? n + ' 个子页 · ' : ''}更新于 ${relTime(p.updatedAt)}</span>
            </a>`;
  }).join('');

  el.article.innerHTML =
    `<div class="meta-row"><nav class="crumbs"><span class="cur">${esc(space.title)}</span></nav></div>
     <div class="space-head">
       <div>
         <h1>${esc(space.title)}</h1>
         ${space.desc ? `<p class="space-desc">${esc(space.desc)}</p>` : ''}
       </div>
       <div class="space-acts">
         <button class="btn btn-new" id="sp-add">＋ 新建页面</button>
         <button class="btn btn-ghost" id="sp-rename">重命名</button>
         <button class="btn btn-ghost danger-text" id="sp-delete">删除空间</button>
       </div>
     </div>
     <div class="cards">${cards || ''}</div>
     ${tops.length ? '' : '<p class="list-empty" style="padding:30px 0">此空间还没有页面，点击右上角「新建页面」开始创作。</p>'}`;

  el.article.hidden = false;
  decorate(el.article);
  $('#sp-add').addEventListener('click', () => createPageFlow(space.slug, null));
  $('#sp-rename').addEventListener('click', () => renameSpaceFlow(space));
  $('#sp-delete').addEventListener('click', () => deleteSpaceFlow(space));
  renderAuthUI();
  renderSidebar(el.search.value);
}

async function openPage(slug) {
  let page;
  try {
    page = await api('pages/' + encodeURIComponent(slug));
  } catch {
    toast('页面不存在，已返回空间总览');
    navigate('/');
    return;
  }
  try {
    S.page = page;
    S.space = null;
    revealPath(page.slug);          // 导航时展开所在路径
    renderArticle(page);
    $('.scroll-area')?.scrollTo?.({ top: 0 });
  } catch (err) {
    console.error(err);
    toast('渲染出错：' + err.message, 4000);
  }
  if (S.pendingEdit === slug) {
    S.pendingEdit = null;
    enterEdit(true);
  }
}

/* ============================================================
   路由（真实路径：/空间/页面/...）
   ============================================================ */
function notFoundThenHome() {
  toast('路径不存在，已返回空间总览');
  history.replaceState(null, '', '/');
  renderHome();
}

async function route() {
  if (location.pathname === '/spaces' || location.pathname === '/spaces/') {
    renderHome();
    return;
  }
  const segs = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!segs.length) { renderHome(); return; }

  const space = spaceBySlug(segs[0]);
  if (!space) {
    // 旧页面路径（该 slug 现在是某空间内的页面）→ 规范化跳转
    const p = pageBySlug(segs[0]);
    if (p) {
      history.replaceState(null, '', canonicalPath(p.slug));
      await openPage(p.slug);
      return;
    }
    notFoundThenHome();
    return;
  }
  if (segs.length === 1) {
    if (space.home && pageBySlug(space.home)) { await openPage(space.home); return; }
    renderSpace(space);
    return;
  }

  // 深链：空间内页面链
  let node = null;
  for (const s of segs.slice(1)) {
    const cand = S.pages.find(x => x.slug === s && x.space === space.slug);
    if (!cand) { notFoundThenHome(); return; }
    if ((cand.parent || null) !== (node ? node.slug : null)) {
      history.replaceState(null, '', canonicalPath(cand.slug));
      await openPage(cand.slug);
      return;
    }
    node = cand;
  }
  await openPage(node.slug);
}

function navigate(path) {
  if (location.pathname === path) { route(); return; }
  history.pushState(null, '', path);
  route();
}
window.addEventListener('popstate', route);

// 站内链接接管
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  const go = () => navigate(a.getAttribute('href'));
  if (S.dirty && !el.editWrap.hidden) {
    confirmModal({ title: '有未保存的修改', desc: '要在离开前保存吗？', ok: '保存并离开' })
      .then(yes => { if (yes) saveDoc().then(go); else go(); });
    return;
  }
  go();
});

/* ============================================================
   全局事件绑定
   ============================================================ */
$('.modal-backdrop', el.modalRoot).addEventListener('click', () => activeModalDone?.());

$('#btn-new').addEventListener('click', () => createSpaceFlow());
$('#btn-empty-create').addEventListener('click', () => createSpaceFlow());
$('#btn-edit').addEventListener('click', () => {
  if (!S.authed) { showLoginDialog({ setup: S.authSetup, then: () => enterEdit(true) }); return; }
  enterEdit(true);
});
$('#btn-save').addEventListener('click', () => saveDoc());
$('#btn-cancel').addEventListener('click', tryCancelEdit);

$('#menu-page').addEventListener('click', e => {
  const act = e.target.closest('.menu-item')?.dataset.act;
  if (!act) return;
  closeMenus(null);
  dispatchPageAction(act);
});

// 侧栏行内菜单（页面 / 空间）
rowMenu.addEventListener('click', e => {
  const act = e.target.closest('.menu-item')?.dataset.act;
  if (!act) return;
  const kind = rowMenu.dataset.kind;
  const slug = rowMenu.dataset.slug;
  rowMenu.hidden = true;
  if (kind === 'space') {
    const sp = spaceBySlug(slug);
    if (!sp) return;
    if (act === 'rename') renameSpaceFlow(sp);
    if (act === 'delete') deleteSpaceFlow(sp);
  } else {
    const pg = pageBySlug(slug);
    if (!pg) return;
    dispatchPageAction(act, pg);
  }
});

// 主题菜单
$$('#menu-theme .menu-item').forEach(b =>
  b.addEventListener('click', () => { applyTheme(b.dataset.pref); closeMenus(null); }));

document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown-wrap') && !e.target.closest('.row-menu')) closeMenus(null);
});

$('#title-input').addEventListener('input', markDirty);
el.editor.addEventListener('input', markDirty);

// 全局快捷键
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!el.editWrap.hidden) saveDoc();
    return;
  }
  if (e.key === 'Escape') {
    if (!el.modalRoot.hidden) { activeModalDone?.(); return; }
    if (!$('#menu-theme').hidden || !$('#menu-page').hidden || !rowMenu.hidden) { closeMenus(null); return; }
    if (document.body.classList.contains('side-open')) { toggleDrawer(false); return; }
    if (!el.editWrap.hidden) tryCancelEdit();
  }
});

window.addEventListener('beforeunload', e => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// 移动端抽屉
function toggleDrawer(open) {
  document.body.classList.toggle('side-open', open);
  el.scrim.hidden = !open;
}
$('#btn-menu').addEventListener('click', () => toggleDrawer(!document.body.classList.contains('side-open')));
el.scrim.addEventListener('click', () => toggleDrawer(false));
window.addEventListener('resize', () => {
  if (innerWidth > 900) toggleDrawer(false);
});

el.list.addEventListener('click', e => {
  if (e.target.closest('.page-item') || e.target.closest('.space-title')) toggleDrawer(false);
});

/* ============================================================
   启动
   ============================================================ */
(async function boot() {
  el.editor.dataset.placeholder = '这里空空如也……开始书写你的第一段文字吧 ✍️';
  try {
    const tree = await api('tree');
    S.spaces = tree.spaces || [];
    S.pages = tree.pages || [];
  } catch (err) {
    toast('无法连接服务器：' + err.message, 4000);
    S.spaces = []; S.pages = [];
  }
  renderSidebar();
  await refreshAuthState();
  await route();
})();
