/* ============================================================
   DocLight · app.ts — framework-free single-page frontend
   v4 space model: spaces[] / pages[] (pages belong to a space and nest inside it)
   Page content is Markdown; the reading view renders it and the editor converts both ways.
   ============================================================ */
import DOMPurify from 'dompurify';
import { htmlToMarkdown, markdownToHtml } from '../markdown.js';
import { DEFAULT_SORT, SORT_KEYS, SORT_LABELS, pageNeighbors } from '../sort.js';
import type { SortKey } from '../sort.js';
import { createMarkdownEditor } from './source-editor.js';
import { SourceDraft } from './source-draft.js';

interface Space {
  slug: string;
  title: string;
  desc: string;
  home: string | null;
  sort?: SortKey;
  order?: string[];
  recommend?: boolean;
  locked?: boolean;
  builtIn?: boolean;
  devEditable?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface PageMeta {
  slug: string;
  space: string;
  parent: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface Page extends PageMeta {
  content: string;
  unclosedFrontMatter?: true;
}

interface TreeResponse {
  spaces: Space[];
  pages: PageMeta[];
}

interface AuthStateResponse {
  mode: 'setup' | 'ready';
  authed: boolean;
  user: string | null;
  salt: string;
  iters: number;
}

// The challenge carries no account name on purpose: the proof is computed from the password and
// the nonce alone, so nothing in this exchange depends on who the visitor claims to be.
interface AuthChallengeResponse {
  nonce: string;
  salt: string;
  iters: number;
}

interface DeleteSpaceResponse {
  ok: true;
  removedSpace: string;
  removedPages: string[];
}

interface ApiError {
  error?: string;
  errorCode?: string;
  needAuth?: boolean;
}

type EditMode = 'visual' | 'markdown';

// Editor hints carry <kbd> chips, so they are assigned with innerHTML — textContent would
// replace the child nodes and strip the key styling the shell's markup defines.
const EDIT_HINTS: Record<EditMode, string> = {
  visual: 'Enter 换行 · 代码块内 <kbd>Tab</kbd> 缩进 · <kbd>Ctrl/⌘ S</kbd> 随时保存 · 粘贴内容将自动清理排版',
  markdown: '直接编辑 Markdown 源码 · <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> 缩进 · <kbd>Ctrl/⌘ S</kbd> 随时保存',
};

interface AppState {
  spaces: Space[];
  pages: PageMeta[];
  page: Page | null;
  space: Space | null;
  dirty: boolean;
  /** Active editing surface. Both modes share one Markdown document; switching re-serialises. */
  editMode: EditMode;
  pendingEdit: string | null;
  authed: boolean;
  authSetup: boolean;
  user: string | null;
  salt: string;
  iters: number;
}

/* ---------------- Utilities ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// The server supplies the public mount point; paths elsewhere in the app are site-relative.
const baseValue = document.querySelector('meta[name="doclight-base-path"]')?.getAttribute('content')?.trim() || '';
const BASE_PATH = baseValue && baseValue !== '/' ? '/' + baseValue.replace(/^\/+|\/+$/g, '') : '';
function withBase(path: string): string {
  return BASE_PATH + (path.startsWith('/') ? path : '/' + path);
}
function withoutBase(path: string): string | null {
  if (!BASE_PATH) return path;
  if (path === BASE_PATH) return '/';
  return path.startsWith(BASE_PATH + '/') ? path.slice(BASE_PATH.length) : null;
}

function esc(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(withBase('/api/' + path), {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data: T | ApiError = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const error = data as ApiError;
    if (res.status === 401 && error.needAuth) { S.authed = false; renderAuthUI(); }
    const failure = Object.assign(new Error(error.error || `请求失败 (${res.status})`), { status: res.status, errorCode: error.errorCode });
    if (appBooted && isBuiltInConflict(failure)) showRuntimeConflict(failure.message);
    throw failure;
  }
  return data as T;
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* Count the visible text only, so Markdown syntax (fences, link targets, emphasis marks)
   never inflates the number. Kept self-contained — it needs no DOM and is unit-tested by
   extracting this function from the compiled bundle (see src/tests/wordcount.test.ts). */
function wordCount(markdown: unknown): number {
  const text = String(markdown || '')
    .replace(/^\s{0,3}```.*$/gm, ' ')          // fence lines only — code text is still counted
    .replace(/`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images contribute no text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links keep their label, drop the target
    .replace(/<[^>]*>/g, ' ')                  // preserved inline HTML
    .replace(/^\s{0,3}>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/gim, '') // callout marker line
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_]{1,3}/g, '')
    .replace(/~{1,2}/g, '')
    .trim();
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + words;
}

/**
 * Sanitizer policy for rendered content. DOMPurify's default allow-list keeps the whole
 * family of form controls, and a form rendered into a document can POST whatever a reader
 * types to an arbitrary host — there is no legitimate use for one here, so they are dropped.
 * The single exception is the GFM task-list checkbox, which the editor itself produces: the
 * hook below keeps that one type, forces it inert, and removes every other input.
 */
const PURIFY_OPTIONS = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['form', 'button', 'select', 'textarea', 'option', 'optgroup', 'fieldset', 'legend'],
};
DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.nodeName !== 'INPUT') return;
  if ((node.getAttribute('type') || '').toLowerCase() === 'checkbox') node.setAttribute('disabled', '');
  else node.remove();
});

/** Render Markdown to safe HTML. Raw HTML in the source passes through `marked` and is then
    sanitised with DOMPurify, so inline preservation cannot become an XSS vector. */
function renderMarkdown(markdown: unknown): string {
  let html = '';
  try { html = markdownToHtml(markdown); } catch { return ''; }
  return DOMPurify.sanitize(html, PURIFY_OPTIONS);
}

function normalizeUrl(u: unknown): string {
  const value = String(u || '').trim();
  if (!value) return '';
  if (/^(https?:\/\/|mailto:|#|\/)/i.test(value)) return value;
  return 'https://' + value;
}
function isSafeSrc(u: unknown): boolean {
  return /^(https?:\/\/|\/|data:image\/)/i.test(String(u));
}

/* ---------------- Auth crypto (built for plain-http safety) ----------------
   Passwords never travel or rest in plaintext: the client derives key ks via
   PBKDF2 and the server stores only ks; login uses a one-shot nonce challenge
   plus an HMAC response to prevent replay.
   Falls back to a pure-JS implementation when WebCrypto is unavailable
   (http on a non-localhost origin). */
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

/* ---------------- Global state ---------------- */
// Human-readable recovery guidance; detection uses the server's structured error code.
const BUILT_IN_CONFLICT = '数据目录中已有空间 doclight-default，请先备份并在 spaces.json 和页面 front matter 中将它改为其他 slug';
let builtInConflict = false;
let builtInConflictMessage = BUILT_IN_CONFLICT;
let appBooted = false;

function isBuiltInConflict(err: any): boolean {
  return err?.status === 503 && err.errorCode === 'BUILT_IN_SLUG_CONFLICT';
}

// Runtime failures must not replace the current view: it may contain an unsaved draft.
function showRuntimeConflict(message = BUILT_IN_CONFLICT): void {
  if (document.getElementById('runtime-conflict')) return;
  const notice = document.createElement('div');
  notice.id = 'runtime-conflict';
  notice.setAttribute('role', 'alert');
  notice.tabIndex = 0;
  notice.textContent = `内置空间名称冲突：${message}。处理完成后请重新加载页面；未保存的草稿请先备份。`;
  document.getElementById('main')!.prepend(notice);
}
const S: AppState = {
  spaces: [],         // [{slug,title,desc,home,...}]
  pages: [],          // [{slug,space,parent,title,...}]
  page: null,         // current page detail
  space: null,        // current space (used by the space index view)
  dirty: false,
  editMode: 'visual',
  pendingEdit: null,
  authed: false,
  authSetup: false,
  user: null,
  salt: '',
  iters: 0,
};

/* ---------------- Element references ---------------- */
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
  sourceEditor: $('#source-editor'),
  sourcePanel: $('#source-panel'),
  sourceWrapToggle: $('#source-wrap-toggle'),
  modeToggle: $('#mode-toggle'),
  editHint: $('#edit-hint'),
  titleInput: $('#title-input'),
  empty: $('#empty-state'),
  toolbarWrap: $('#toolbar-wrap'),
  modalRoot: $('#modal-root'),
  toasts: $('#toasts'),
};

/* ============================================================
   Toasts
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
   Modal (confirm / prompt)
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

function confirmModal({ title, desc, ok = '确定', danger = false }: { title: string; desc?: string; ok?: string; danger?: boolean }): Promise<boolean> {
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

function promptModal({ title, label, value = '', placeholder = '', ok = '确定' }: { title: string; label?: string; value?: string; placeholder?: string; ok?: string }): Promise<string | null> {
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
   Dropdown menus (theme / page actions / inline menus)
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
  if (kind === 'space' && obj.builtIn && !devSourceEditable(obj)) return;
  const r = btn.getBoundingClientRect();
  rowMenu.dataset.kind = kind;
  rowMenu.dataset.slug = obj.slug;
  rowMenu.innerHTML = kind === 'space'
    ? `
      ${pageContentLocked(obj) ? '' : '<button class="menu-item" data-act="rename"><span>重命名空间…</span></button>'}
      <button class="menu-item" data-act="settings"><span>空间设置…</span></button>
      ${pageContentLocked(obj) || (obj.builtIn && !devSourceEditable(obj)) ? '' : '<button class="menu-item danger" data-act="delete"><span>删除空间…</span></button>'}`
    : `
      <button class="menu-item" data-act="rename"><span>重命名…</span></button>
      <button class="menu-item" data-act="slug"><span>编辑路径…</span></button>
      <button class="menu-item" data-act="move"><span>移动到…</span></button>
      <button class="menu-item danger" data-act="delete"><span>删除…</span></button>`;
  rowMenu.hidden = false;
  const mw = 176, mh = kind === 'space' ? (pageContentLocked(obj) ? 50 : 245) : 190;
  rowMenu.style.left = Math.max(8, Math.min(r.left - mw + 12, innerWidth - mw - 8)) + 'px';
  rowMenu.style.top = Math.min(r.bottom + 4, innerHeight - mh - 8) + 'px';
}

// Toggle top-bar dropdown buttons (theme / page actions)
menus.forEach(({ btn, panel }) => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeMenus(panel);
    panel.hidden = !willOpen;
  });
});

/* ============================================================
   Theme: auto / light / dark (follows the system with local memory)
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
    if (!svg) return;
    const active = k === pref;
    // `hidden` is an IDL attribute of HTMLElement only; SVGElement has none.
    // Assigning `svg.hidden = x` just plants a JS expando and never touches the
    // content attribute, so the [hidden] CSS rule below kept every icon hidden
    // forever once an explicit light/dark preference was chosen.
    svg.toggleAttribute('hidden', !active);
    svg.style.display = active ? '' : 'none';
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
   Auth state (the server is the single source of truth)
   ============================================================ */
async function refreshAuthState() {
  try {
    const st = await api<AuthStateResponse>('auth/state');
    S.authSetup = st.mode === 'setup';
    S.authed = !!st.authed;
    S.user = st.authed ? (st.user || null) : null;
    S.salt = st.salt; S.iters = st.iters;
  } catch { /* 网络异常时保留旧状态 */ }
  renderAuthUI();
}

function renderAuthUI() {
  const b = $('#btn-auth');
  b.hidden = !el.editWrap.hidden;   // Keep account actions out of the editor, including its unsaved draft.
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

// The login dialog borrows the shared modal element and the caller's continuation, so a stale
// instance must never act again once the user dismissed it. Every dialog registers its own
// `cancel` here; opening a second one supersedes the first instead of stacking closures on the
// same `.modal` node (a keydown listener added there outlived `innerHTML = ''` and fired once
// more per reopening).
let closeLoginDialog: (() => void) | null = null;

/* ---------------- Remembered account name ---------------- */
// A visitor who is not signed in cannot learn the account name from the server — the session
// state only names whoever is logged in — so the login form remembers it locally instead. Only
// the name is kept: the password, the derived key, nonces and proofs must never be written to
// disk, and the browser's own autofill is free to supply everything else.
const LOGIN_USER_KEY = 'doclight-login-user';

/** Stored account name, or '' when nothing usable is available (also under privacy mode). */
function readRememberedUser(): string {
  try {
    const saved = localStorage.getItem(LOGIN_USER_KEY);
    if (typeof saved !== 'string') return '';
    const name = saved.trim();
    return name && name.length <= 40 ? name : '';
  } catch { return ''; }   // disabled storage: leave the field to the browser's autofill
}

/** Remember a name that the server just accepted; failures never block the sign-in. */
function rememberUser(name: string): void {
  const saved = name.trim();
  if (!saved) return;
  try { localStorage.setItem(LOGIN_USER_KEY, saved.slice(0, 40)); } catch { /* ignore */ }
}

function showLoginDialog({ setup = false, then }: { setup?: boolean; then?: () => void } = {}) {
  closeLoginDialog?.();
  const m = openModal(`
    <h3>${setup ? '初始化站长账号' : '登录 DocLight'}</h3>
    <p class="desc">${setup
      ? '首次使用，设置用户名与密码。密码经 PBKDF2 派生，明文不落盘、不上网。用户名仅限字母、数字、_ 或 -。'
      : '修改内容前需要登录（阅读始终公开）。'}</p>
    <input id="lg-user" type="text" placeholder="${setup ? '请设置用户名' : '请输入用户名'}" maxlength="40" autocomplete="username" value="${setup ? '' : esc(readRememberedUser())}">
    <input id="lg-pass" type="password" placeholder="密码" autocomplete="${setup ? 'new-password' : 'current-password'}">
    ${setup ? '<input id="lg-pass2" type="password" placeholder="确认密码" autocomplete="new-password">' : ''}
    <p class="desc" id="lg-err" style="color:var(--danger)" hidden></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-x="no">取消</button>
      <button class="btn btn-primary" data-x="ok">${setup ? '创建并登录' : '登录'}</button>
    </div>`);
  const $lg = s => $(s, m);
  // Capture the nodes once: after `closeModal()` empties `.modal` they are detached, which is
  // exactly how a finishing request tells that its dialog is gone.
  const userInput = $lg('#lg-user');
  const passInput = $lg('#lg-pass');
  const pass2Input = $lg('#lg-pass2');
  const errBox = $lg('#lg-err');
  const okBtn = $lg('[data-x=ok]');
  const idleLabel = setup ? '创建并登录' : '登录';
  const err = t => { errBox.textContent = t; errBox.hidden = !t; };
  let busy = false;   // one request at a time: Enter, click and the re-enabled button all funnel here
  let cancelled = false;
  // Cancelled, or replaced by another modal: either way there is nothing left to paint, and a
  // caller's flow must not resume. `isConnected` is the exact test — every route that takes the
  // dialog away (`closeModal`, another `openModal`) replaces `.modal`'s children.
  const alive = () => !cancelled && userInput.isConnected;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (closeLoginDialog === cancel) closeLoginDialog = null;
    passInput.value = '';
    if (pass2Input) pass2Input.value = '';
    if (userInput.isConnected) closeModal();   // another modal may already own the slot
  };
  const submit = async () => {
    if (busy || cancelled) return;
    const user = userInput.value.trim();
    const pass = passInput.value;
    // Both setup and login require an account name; validate its format before making a request.
    if (!user) { err('请输入用户名'); return; }
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(user)) { err('用户名仅限字母、数字、下划线、连字符（≤40 位）'); return; }
    if (!/^[\x20-\x7E]+$/.test(pass)) { err('密码仅支持英文、数字与半角符号，不能包含中文或全角字符'); return; }
    if (pass.length < 6) { err('密码长度至少 6 位'); return; }
    if (setup && pass !== pass2Input.value) { err('两次输入的密码不一致'); return; }
    busy = true;
    okBtn.disabled = true; okBtn.textContent = '验证中…'; err('');
    try {
      if (setup) {
        const ks = await deriveKeyHex(pass, S.salt, S.iters);
        if (!alive()) return;   // nothing was sent yet, so there is no session change to sync
        await api('auth/setup', { method: 'POST', body: JSON.stringify({ user, ks }) });
      } else {
        const ch = await api<AuthChallengeResponse>('auth/challenge');
        const k = await deriveKeyHex(pass, ch.salt, ch.iters);
        const proof = await hmacHex(k, ch.nonce);
        if (!alive()) return;
        // The server checks the submitted name and password proof before creating a session.
        await api('auth/login', { method: 'POST', body: JSON.stringify({ user, nonce: ch.nonce, proof }) });
      }
      // The credentials were already sent: a dialog cancelled mid-flight still has to resync the
      // session, because the server may have accepted the login before the user dismissed it.
      await refreshAuthState();
      if (!alive()) return;   // dismissed ⇢ sync the state, but never remember or resume
      // Remember only a sign-in the user actually completed, and only the name the session
      // confirms. A failed attempt or a cancel never writes, so the memory cannot go stale.
      if (S.authed) rememberUser(S.user || user);
      closeModal();
      if (closeLoginDialog === cancel) closeLoginDialog = null;
      toast(setup ? '账号已创建 ✓' : `欢迎回来，${S.user}`);
      then?.();
    } catch (e2) {
      if (!alive()) return;
      busy = false;
      okBtn.disabled = false; okBtn.textContent = idleLabel;
      err(e2.message || '操作失败');
    }
  };
  // Enter is bound to the freshly created inputs rather than to `.modal`: those nodes die with
  // the dialog, so a reopening cannot inherit an extra handler, and `preventDefault` keeps a
  // second activation from reaching the same round trip.
  const onEnter = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  userInput.addEventListener('keydown', onEnter);
  passInput.addEventListener('keydown', onEnter);
  pass2Input?.addEventListener('keydown', onEnter);
  $('[data-x=no]', m).onclick = cancel;
  okBtn.onclick = submit;
  closeLoginDialog = cancel;
  activeModalDone = cancel;
  userInput.focus();
}

/* ============================================================
   Hierarchy (space → page tree)
   ============================================================ */
function spaceBySlug(slug) { return S.spaces.find(s => s.slug === slug) || null; }
// Development mode permits editing the built-in virtual space despite its lock.
function devSourceEditable(space: Space | null | undefined): boolean {
  return !!(space?.builtIn && space.locked && space.devEditable);
}
function pageContentLocked(space: Space | null | undefined): boolean {
  return !!space?.locked && !devSourceEditable(space);
}
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
  const seen = new Set<string>();
  let cur = page;
  while (cur && !seen.has(cur.slug)) {
    seen.add(cur.slug);
    chain.unshift(cur);
    cur = cur.parent ? pageBySlug(cur.parent) : null;
  }
  return space ? [space, ...chain] : chain;
}
function canonicalPath(slug) {
  if (spaceBySlug(slug)) return withBase('/' + encodeURIComponent(slug));
  return withBase('/' + chainOf(slug).map(n => encodeURIComponent(n.slug)).join('/'));
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

// Auto-expand the space and ancestor chain when navigating to a page
// (called on navigation only, so manual collapse is never overridden)
function revealPath(pageSlug) {
  const page = pageBySlug(pageSlug);
  if (!page) return;
  collapsedSet.delete('s:' + page.space);
  for (const node of chainOf(pageSlug)) collapsedSet.delete('p:' + node.slug);
}

/* ============================================================
   Sidebar: space sections + page tree
   ============================================================ */
const TREE_GRIP_SVG = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor">' +
  '<circle cx="2.6" cy="3.2" r="1.35"/><circle cx="7.4" cy="3.2" r="1.35"/>' +
  '<circle cx="2.6" cy="8" r="1.35"/><circle cx="7.4" cy="8" r="1.35"/>' +
  '<circle cx="2.6" cy="12.8" r="1.35"/><circle cx="7.4" cy="12.8" r="1.35"/></g></svg>';

/**
 * Drag handle for a sidebar page row. The grip is the only drag surface, so pressing the row
 * itself keeps behaving like a plain link — on touch, a long press there raises the browser's
 * own link menu, which is exactly what the handle avoids.
 */
function sidebarGrip(depth: number): HTMLElement {
  const grip = document.createElement('span');
  grip.className = 'tree-grip';
  grip.title = '拖动调整顺序';
  grip.setAttribute('aria-hidden', 'true');
  grip.style.left = (depth * 16 + 3) + 'px';
  grip.innerHTML = TREE_GRIP_SVG;
  return grip;
}

function renderSidebar(filter = '') {
  const q = filter.trim().toLowerCase();
  el.list.innerHTML = '';

  if (builtInConflict) {
    el.countHint.textContent = '';
    return;
  }
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
      a.innerHTML = `<span class="t">${esc(p.title)}</span><span class="s">${esc(sp?.title || '')}${chain ? ' / ' + esc(chain) + ' · ' : ' · '}${sp?.builtIn ? '随应用更新' : relTime(p.updatedAt)}</span>`;
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
    t.href = canonicalPath(space.slug);
    t.dataset.nav = '';
    t.innerHTML = `<span class="t">${esc(space.title)}</span><span class="s">${space.builtIn ? `<span class="lock-badge">${devSourceEditable(space) ? '开发者模式：可编辑模板源码' : '🔒 永久只读'}</span> · ` : space.locked ? '<span class="lock-badge">🔒 已锁定</span> · ' : ''}${tops.length} 页</span>`;

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
    if (!pageContentLocked(space)) actions.append(addBtn);
    if (!space.builtIn || devSourceEditable(space)) actions.append(moreBtn);

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
          row.dataset.slug = p.slug;
          row.dataset.parent = p.parent || '';
          row.dataset.space = space.slug;
          row.dataset.depth = String(depth);

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

          const reorderable = !pageContentLocked(space) || devSourceEditable(space);
          const a = document.createElement('a');
          a.className = 'page-item' + (S.page?.slug === p.slug ? ' active' : '');
          a.href = canonicalPath(p.slug);
          a.dataset.nav = '';
          a.style.paddingLeft = (10 + depth * 16 + (reorderable ? 18 : 0)) + 'px';
          a.draggable = false;
          a.innerHTML = `<span class="t">${esc(p.title)}</span><span class="s">${space.builtIn ? '随应用更新' : relTime(p.updatedAt)}${kids.length ? ' · ' + kids.length + ' 子页' : ''}</span>`;
          if (reorderable) a.append(sidebarGrip(depth));

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
          if (!pageContentLocked(space)) acts.append(pa, pm);

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
   Reading-view width: capped by default, draggable on desktop
   ============================================================ */
const READING_KEY = 'doclight-reading-width';
const READING_DEFAULT = 760;
const READING_MIN = 480;
const READING_STEP = 20;

// The upper bound comes from the usable width of .scroll-area (minus 24px of
// breathing room) so dragging to the edge never escapes the page bounds; the
// CSS min() is a second safety net once the window is resized.
function readingMax(): number {
  const area = el.article.parentElement;
  const avail = (area?.clientWidth || innerWidth) - 24;
  return Math.max(READING_MIN, avail);
}

function clampReadingWidth(px: number): number {
  return Math.max(READING_MIN, Math.min(Math.round(px), readingMax()));
}

function applyReadingWidth(px: number): number {
  const w = clampReadingWidth(px);
  readingApplied = w;
  document.documentElement.style.setProperty('--reading-w', w + 'px');
  $('.reading-handle')?.setAttribute('aria-valuenow', String(w));
  return w;
}

// readingWidth is the user preference (persisted); readingApplied is the value
// actually in effect. Keeping them apart means a narrower window only squeezes
// the effective width without damaging the preference, so it recovers when
// widened again; dragging starts from the effective width, otherwise a small
// drag would do nothing when the stored preference exceeds the current cap.
let readingWidth = READING_DEFAULT;
let readingApplied = READING_DEFAULT;
try {
  const saved = Number(localStorage.getItem(READING_KEY));
  if (Number.isFinite(saved) && saved > 0) readingWidth = saved;
} catch { /* ignore */ }
applyReadingWidth(readingWidth);

function persistReadingWidth(): void {
  try { localStorage.setItem(READING_KEY, String(readingWidth)); } catch { /* ignore */ }
}

function resetReadingWidth(): void {
  readingWidth = applyReadingWidth(READING_DEFAULT);
  persistReadingWidth();
}

function setupReadingHandle(handle: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = readingApplied;
    document.body.classList.add('reading-resizing');
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    // Centered text column: moving the right edge by dx widens both sides, so the total width changes by 2*dx
    readingWidth = applyReadingWidth(startWidth + (e.clientX - startX) * 2);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('reading-resizing');
    persistReadingWidth();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', resetReadingWidth);
  handle.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? READING_STEP : -READING_STEP;
    readingWidth = applyReadingWidth(readingApplied + step);
    persistReadingWidth();
  });
}

function mountReadingHandle(): void {
  const handle = document.createElement('div');
  handle.className = 'reading-handle';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '拖动调整正文宽度，双击恢复默认');
  handle.title = '拖动调整正文宽度，双击恢复默认';
  handle.setAttribute('aria-valuemin', String(READING_MIN));
  handle.setAttribute('aria-valuemax', String(readingMax()));
  handle.setAttribute('aria-valuenow', String(readingApplied));
  el.article.appendChild(handle);
  setupReadingHandle(handle);
}

/* ============================================================
   Reading view rendering
   ============================================================ */
function decorate(container) {
  container.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    // Only treat root-relative Markdown links as app routes when the tree confirms them.
    // Leave assets, other applications, protocol-relative and fragment links untouched.
    if (href.startsWith('/') && !href.startsWith('//')) {
      const url = new URL(href, location.origin);
      const knownPaths = [...S.spaces, ...S.pages].map(item => withoutBase(canonicalPath(item.slug)));
      const stripped = withoutBase(url.pathname);
      const candidate = stripped !== null && knownPaths.includes(stripped) ? stripped : url.pathname;
      if (knownPaths.includes(candidate)) {
        a.setAttribute('href', withBase(candidate) + url.search + url.hash);
        a.setAttribute('data-nav', '');
      }
    }
  });
  container.querySelectorAll('img').forEach(img => img.loading = 'lazy');
  // h2/h3 reveal a label-style anchor on hover; clicking copies a clean section link (/path#h-x)
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

/**
 * "Recommend other articles" footer, rendered only when the space enables it.
 *
 * Order follows the sidebar (depth-first over the space tree), so previous/next read in the same
 * sequence the tree navigates. The first and last page get a single card, and a space holding one
 * page shows none.
 */
function recommendFooter(space, page) {
  if (!space?.recommend) return '';
  const { prev, next } = pageNeighbors(S.pages, page.slug);
  if (!prev && !next) return '';
  const card = (target, dir, kind) => `<a class="page-nav-card ${kind}" data-nav href="${esc(canonicalPath(target.slug))}">
      <span class="dir">${dir}</span>
      <span class="t">${esc(target.title)}</span>
    </a>`;
  return `<nav class="page-nav" aria-label="上一篇 / 下一篇">
      ${prev ? card(prev, '← 上一篇', 'prev') : ''}
      ${next ? card(next, '下一篇 →', 'next') : ''}
    </nav>`;
}

function renderArticle(page) {
  destroySourceEditor();
  const space = spaceBySlug(page.space);
  const locked = pageContentLocked(space);
  const chain = chainOf(page.slug);
  const crumbsHtml = chain.map((n, i) =>
    n === chain[chain.length - 1]
      ? `<span class="cur">${esc(n.title)}</span>`
      : `<a href="${esc(canonicalPath(n.slug))}" data-nav>${esc(n.title)}</a>`
  ).join('<span class="sep">/</span>');

  el.article.innerHTML =
    `<div class="meta-row">
       <nav class="crumbs">${crumbsHtml}</nav><span class="sep">·</span>
       <span>${space?.builtIn ? '随应用更新' : `更新于 ${relTime(page.updatedAt)}`}</span><span class="sep">·</span>
       <span>${wordCount(page.content)} 字</span><span class="sep">·</span>
       <a href="javascript:void 0" id="copy-link">复制页面链接</a><span class="sep">·</span>
       ${devSourceEditable(space) ? `<a href="javascript:void 0" id="slug-edit" class="slug-chip" title="编辑页面路径">#${esc(page.slug)}</a><span class="lock-badge">开发者模式：编辑将写入模板源码</span>` : locked ? `<span class="slug-chip">#${esc(page.slug)}</span><span class="lock-badge">🔒 ${space?.builtIn ? '内置空间，永久只读' : '空间已锁定，只读'}</span>` : `<a href="javascript:void 0" id="slug-edit" class="slug-chip" title="编辑页面路径">#${esc(page.slug)}</a>`}
     </div>` + renderMarkdown(page.content) + recommendFooter(space, page);

  decorate(el.article);
  $('#copy-link').addEventListener('click', () => {
    (navigator.clipboard?.writeText(location.href) ?? Promise.reject())
      .then(() => toast('页面链接已复制'))
      .catch(() => toast('复制失败'));
  });
  $('#slug-edit')?.addEventListener('click', () => slugFlow(S.page));
  $('#btn-edit').hidden = pageContentLocked(space);
  $('#btn-more').hidden = locked && !devSourceEditable(space);
  $('#menu-page [data-act="slug"]').hidden = false;

  // The width cap applies to the reading view only: overview, space index and editor all go full width
  el.article.classList.add('is-reading');
  applyReadingWidth(readingWidth);
  mountReadingHandle();

  const crumbText = chain.map(n => n.title).join(' / ');
  el.crumb.textContent = crumbText.length > 26 ? crumbText.slice(0, 26) + '…' : crumbText;
  document.title = page.title + ' · DocLight';

  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.empty.hidden = true;
  el.article.hidden = false;
  el.clusterEdit.hidden = true;
  el.clusterView.hidden = pageContentLocked(space);
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  renderAuthUI();
  renderSidebar(el.search.value);
}

/* ============================================================
   Editor core
   ============================================================ */
const SOURCE_WRAP_KEY = 'doclight-markdown-wrap';
let sourceWrap = true;
try { sourceWrap = localStorage.getItem(SOURCE_WRAP_KEY) !== 'off'; } catch { /* default on */ }
let sourceView: ReturnType<typeof createMarkdownEditor> | null = null;
let sourceGeneration = 0;
const sourceDraft = new SourceDraft();
let markdownDraft = '';
let visualBaseline = '';

function destroySourceEditor() {
  sourceGeneration++;
  sourceView?.destroy();
  sourceView = null;
}

function renderSourceWrap() {
  el.sourceWrapToggle.setAttribute('aria-pressed', String(sourceWrap));
  el.sourceWrapToggle.textContent = `自动换行：${sourceWrap ? '开' : '关'}`;
}

el.sourceWrapToggle.addEventListener('click', () => {
  sourceWrap = !sourceWrap;
  try { localStorage.setItem(SOURCE_WRAP_KEY, sourceWrap ? 'on' : 'off'); } catch { /* preference is optional */ }
  sourceView?.setWrap(sourceWrap);
  renderSourceWrap();
});
renderSourceWrap();

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

/** Read the document from whichever surface is active, in Markdown form. */
function currentMarkdown(): string {
  return S.editMode === 'markdown'
    ? sourceDraft.read(markdownDraft)
    : el.editor.innerHTML === visualBaseline ? markdownDraft : htmlToMarkdown(el.editor.innerHTML);
}

/** Reflect the active mode on the segmented control, visually and for assistive tech. */
function renderModeToggle(mode: EditMode) {
  $$('#mode-toggle .seg-btn').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/**
 * Switch between the visual and Markdown surfaces without
 * losing edits. Both surfaces describe the same Markdown document, so the outgoing one is
 * serialised first and the incoming one is rebuilt from it. Kept idempotent: selecting the
 * already-active mode does nothing, so a stray click cannot reflow the document.
 */
function setEditMode(mode: EditMode, focus = true) {
  if (S.editMode === mode) return;
  // Capture before flipping the flag, otherwise the reader would consult the wrong surface.
  const markdown = currentMarkdown();
  markdownDraft = markdown;
  S.editMode = mode;

  const visual = mode === 'visual';
  el.editor.hidden = !visual;
  el.sourcePanel.hidden = visual;
  // The formatting toolbar only makes sense for the WYSIWYG surface; Markdown is edited raw.
  el.toolbarWrap.hidden = !visual;
  el.editHint.innerHTML = visual ? EDIT_HINTS.visual : EDIT_HINTS.markdown;

  if (visual) {
    el.editor.innerHTML = renderMarkdown(markdown);
    visualBaseline = el.editor.innerHTML;
    if (focus) placeCaretEnd(el.editor);
    setTimeout(() => refreshToolbarState(), 50);
  } else {
    if (!sourceView || sourceView.view.state.doc.toString() !== markdown) {
      destroySourceEditor();
      sourceDraft.clear();
      const generation = sourceGeneration;
      sourceView = createMarkdownEditor(el.sourceEditor, markdown, sourceWrap, document => {
        if (S.editMode !== 'markdown' || generation !== sourceGeneration) return;
        sourceDraft.update(document);
        markDirty();
      });
      sourceDraft.update(sourceView.view.state.doc);
    } else {
      sourceView.view.requestMeasure();
    }
    if (focus) sourceView.view.focus();
  }
  renderModeToggle(mode);
}

// Keep lock status visible in the editor without rebuilding either draft surface.
function renderEditorLockStatus() {
  let badge = el.clusterEdit.querySelector('.editor-lock-badge') as HTMLElement | null;
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'lock-badge editor-lock-badge';
    badge.setAttribute('role', 'status');
    el.clusterEdit.insertBefore(badge, el.dirtyPill);
  }
  const space = S.page && spaceBySlug(S.page.space);
  badge.hidden = !space?.locked;
  badge.textContent = devSourceEditable(space) ? '开发者模式' : space?.builtIn ? '🔒 内置空间，永久只读' : '🔒 空间已锁定，只读；草稿保留，解锁后可保存';
}

function enterEdit(focus = true) {
  if (!S.page) return;
  if (S.page.unclosedFrontMatter) { toast('页面开头的元数据围栏未闭合，请先检查原始文件；为保护内容，暂不能编辑。', 6000); return; }
  if (pageContentLocked(spaceBySlug(S.page.space))) { toast('空间已锁定，请先解锁'); return; }
  S.dirty = false;
  // The editor always goes full width, unaffected by the reading-view cap
  el.article.classList.remove('is-reading');
  el.article.hidden = true;
  el.empty.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = false;
  renderEditorLockStatus();
  el.editWrap.hidden = false;
  renderAuthUI();
  el.titleInput.value = S.page.title;

  // Keep the original body until the visual surface actually changes; merely opening the
  // editor or changing the title must not normalise hand-written Markdown.
  destroySourceEditor();
  sourceDraft.clear();
  markdownDraft = S.page.content || '';
  S.editMode = 'visual';
  el.editor.innerHTML = renderMarkdown(markdownDraft);
  visualBaseline = el.editor.innerHTML;
  el.editor.hidden = false;
  el.sourcePanel.hidden = true;
  el.toolbarWrap.hidden = false;
  el.editHint.innerHTML = EDIT_HINTS.visual;
  renderModeToggle('visual');
  if (focus) placeCaretEnd(el.editor);
  setTimeout(() => refreshToolbarState(), 50);
}

async function exitEdit(reloadFromPage) {
  if (reloadFromPage && S.page) {
    try { S.page = await api<Page>('pages/' + encodeURIComponent(S.page.slug)); } catch { /* keep */ }
  }
  S.dirty = false;
  if (S.page) renderArticle(S.page);
}

async function saveDoc() {
  if (!S.page) return;
  if (pageContentLocked(spaceBySlug(S.page.space))) { toast('空间已锁定，请先解锁；编辑内容仍保留', 4000); return; }
  if (!S.dirty) { await exitEdit(false); return; }
  const title = el.titleInput.value.trim() || '无标题页面';
  // Storage is Markdown regardless of the active surface: the visual editor is serialised,
  // the Markdown editor is already raw text.
  const content = currentMarkdown();
  el.btnSave.disabled = true;
  try {
    const updated = await api<Page>('pages/' + encodeURIComponent(S.page.slug), {
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
    await refreshTree();          // updatedAt moved, so time-ordered spaces can reorder
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
   Rich-text commands
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
    if (n.nodeType === Node.ELEMENT_NODE && /^(H1|H2|H3|P|PRE|BLOCKQUOTE)$/.test((n as Element).tagName)) return (n as Element).tagName;
    n = n.parentNode;
  }
  return null;
}

function refreshToolbarState() {
  if (el.editWrap.hidden || S.editMode !== 'visual') return;
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
  const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  if (!range || !el.editor.contains(range.commonAncestorContainer)) return;
  const text = range.toString();
  const existing = sel.anchorNode?.parentElement?.closest('a');
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
  // The prompt focuses its input, so restore the editor selection before using browser commands.
  if (el.editWrap.hidden || S.editMode !== 'visual' || !el.editor.contains(range.commonAncestorContainer)) {
    toast('编辑位置已失效，请重新选择文本');
    return;
  }
  el.editor.focus();
  sel.removeAllRanges();
  sel.addRange(range);
  if (existing && el.editor.contains(existing)) {
    existing.setAttribute('href', finalUrl);
  } else if (text.trim()) {
    if (!document.execCommand('createLink', false, finalUrl)) { toast('插入链接失败'); return; }
    const a = sel.anchorNode?.parentElement?.closest('a');
    if (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  } else {
    if (!document.execCommand('insertHTML', false,
      `<a href="${esc(finalUrl)}" target="_blank" rel="noopener noreferrer">${esc(finalUrl)}</a>&nbsp;`)) {
      toast('插入链接失败');
      return;
    }
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

/* Clear formatting: turn selected blocks into body text and strip all inline styles and alignment (code blocks preserved) */
function clearFormatting() {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const orig = sel.getRangeAt(0);

  document.execCommand('removeFormat', false, null);
  document.execCommand('unlink', false, null);

  const codes = [];
  const walker = document.createTreeWalker(el.editor, NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => ((n as Element).tagName === 'CODE' && !(n as Element).closest('pre') && orig.intersectsNode(n))
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

/* Paste cleanup: keep semantic tags, strip scripts and inline junk */
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

/* Toolbar event dispatch */
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
   Space operations
   ============================================================ */
async function lockSpaceFlow(space: Space) {
  if (!S.authed) {
    showLoginDialog({ setup: S.authSetup, then: () => { const current = spaceBySlug(space.slug); if (current) lockSpaceFlow(current); } });
    return;
  }
  const locked = !space.locked;
  const apply = async (body: object) => {
    await api('spaces/' + encodeURIComponent(space.slug) + '/lock', { method: 'POST', body: JSON.stringify(body) });
    const current = spaceBySlug(space.slug);
    if (current) current.locked = locked;
    if (S.space?.slug === space.slug) S.space.locked = locked;
    if (!el.editWrap.hidden) {
      renderEditorLockStatus();
      renderSidebar(el.search.value);
      if (S.page?.space === space.slug) toast(locked ? '空间已锁定，编辑内容仍保留；解锁后才能保存' : '空间已解锁，可以继续保存', 4000);
      else toast(locked ? '空间已锁定' : '空间已解锁');
    } else {
      if (S.space?.slug === space.slug) renderSpace(S.space);
      else if (S.page?.space === space.slug) renderArticle(S.page);
      else if (!S.page && !S.space) renderHome();
      else renderSidebar(el.search.value);
      toast(locked ? '空间已锁定' : '空间已解锁');
    }
  };
  if (locked) {
    const yes = await confirmModal({ title: `锁定空间「${space.title}」？`, desc: '锁定后内容仍可阅读，编辑和管理操作需要先解锁。', ok: '锁定' });
    if (!yes) return;
    try { await apply({ locked: true }); } catch (err) { toast(err.message || '锁定失败', 4000); }
    return;
  }
  const m = openModal(`
    <h3>解锁空间「${esc(space.title)}」</h3>
    <p class="desc">请输入当前登录账号的密码。密码会在浏览器中用于生成验证信息，密码明文不会发送。远程访问请使用 HTTPS。</p>
    <input type="password" autocomplete="current-password" placeholder="登录密码">
    <p class="desc" data-x="error" style="color:var(--danger)" hidden></p>
    <div class="modal-actions"><button class="btn btn-ghost" data-x="no">取消</button><button class="btn btn-primary" data-x="ok">解锁</button></div>`);
  const input = $('input', m) as HTMLInputElement;
  const button = $('[data-x=ok]', m) as HTMLButtonElement;
  const error = $('[data-x=error]', m) as HTMLElement;
  let cancelled = false;
  const cancel = () => { cancelled = true; input.value = ''; closeModal(); };
  const submit = async () => {
    if (button.disabled) return;
    if (!input.value) { error.textContent = '请输入登录密码'; error.hidden = false; return; }
    button.disabled = true; button.textContent = '验证中…'; error.hidden = true;
    try {
      const ch = await api<AuthChallengeResponse>('auth/challenge');
      const key = await deriveKeyHex(input.value, ch.salt, ch.iters);
      const proof = await hmacHex(key, ch.nonce);
      input.value = '';
      if (cancelled) return;
      await apply({ locked: false, nonce: ch.nonce, proof });
      if (!cancelled) closeModal();
    } catch (err) {
      if (cancelled) return;
      error.textContent = err.message || '解锁失败'; error.hidden = false;
      button.disabled = false; button.textContent = '解锁';
    }
  };
  $('[data-x=no]', m).onclick = cancel;
  button.onclick = submit;
  activeModalDone = cancel;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

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
    const space = await api<Space>('spaces', { method: 'POST', body: JSON.stringify({ title }) });
    S.spaces.push(space);
    toast('空间已创建 ✓');
    navigate(canonicalPath(space.slug));
  } catch (err) { toast(err.message, 3000); }
}

async function renameSpaceFlow(space) {
  if (!space) return;
  const title = await promptModal({ title: '重命名空间', value: space.title, ok: '保存' });
  if (title === null || !title || title === space.title) return;
  try {
    const updated = await api<Space>('spaces/' + encodeURIComponent(space.slug), {
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

/**
 * Re-read the tree after a mutation that can change page order.
 *
 * Order is derived from the page fields on the server (see src/sort.ts), so a local splice can
 * never reproduce it — patching `S.pages` in place would leave the sidebar ordered by the old
 * key until the next reload. Refetching keeps one definition of the order instead of two that
 * can drift.
 *
 * A failure here is deliberately swallowed: the mutation itself already succeeded, so turning a
 * failed order-refresh into an error toast would report failure for an action that worked. The
 * caller's local update stays in place and the order catches up on the next fetch.
 */
async function refreshTree() {
  try {
    const tree = await api<TreeResponse>('tree');
    S.spaces = tree.spaces || S.spaces;
    S.pages = tree.pages || S.pages;
    // The space index renders `sort`, so it has to point at the refetched record, not the old one.
    if (S.space) S.space = S.spaces.find(s => s.slug === S.space.slug) || S.space;
  } catch (err) {
    if (isBuiltInConflict(err)) showRuntimeConflict();
    // Keep local state; the mutation succeeded even if its order refresh failed.
  }
}

/**
 * Persist one space-settings change and refresh whatever depends on it.
 *
 * Order is computed server-side from the page fields, so the tree is refetched rather than patched
 * locally — that keeps one definition of the order instead of two that can drift. The failure
 * branch must never navigate: the settings entry is reachable from every route, and rendering the
 * index clears `S.page`, hides the editor and empties `#editor`, which used to discard unsaved
 * work with no confirmation.
 */
async function saveSpaceSettings(space, changes: { sort?: SortKey | null; recommend?: boolean }, note = '空间设置已更新 ✓') {
  if (!space || !Object.keys(changes).length) return;
  try {
    const updated = await api<Space>('spaces/' + encodeURIComponent(space.slug), {
      method: 'PUT', body: JSON.stringify(changes),
    });
    const i = S.spaces.findIndex(s => s.slug === space.slug);
    if (i >= 0) S.spaces[i] = updated;
    // Keep `S.space` in step even if the refetch below fails, so the index renders the value the
    // server just stored rather than the one it replaced.
    if (S.space?.slug === space.slug) S.space = updated;
    await refreshTree();
    if (S.space?.slug === space.slug) renderSpace(S.space);
    // The reading view only needs a re-render when the recommendation footer itself changed, and
    // never while the editor is open: re-rendering the article would discard unsaved content.
    else if (changes.recommend !== undefined && S.page?.space === space.slug && el.editWrap.hidden) renderArticle(S.page);
    else renderSidebar(el.search.value);
    toast(note);
  } catch (err) {
    toast(err.message, 3000);
    // The stored value is unchanged, so only the index's own controls need putting back.
    if (S.space?.slug === space.slug) renderSpace(S.space);
    else renderSidebar(el.search.value);
  }
}

async function setSpaceSort(space, key) {
  // Choosing the default clears the field rather than writing it, so an untouched space keeps no
  // `sort` key and a future change of the default still reaches the files that never set one.
  await saveSpaceSettings(space, { sort: key === DEFAULT_SORT ? null : key }, '排序已更新 ✓');
}

/**
 * Space settings: the ordering picker, reachable from the space row menu.
 *
 * The same control also sits on the space index, but a space with a `home` never shows that
 * index — `/space` opens the home page instead — so the sample space shipped with DocLight
 * would otherwise offer no way to reach it at all.
 */
async function spaceSettingsFlow(space) {
  if (!space) return;
  const locked = pageContentLocked(space);
  const m = openModal(`
    <h3>空间设置</h3>
    <p class="desc">${esc(space.title)}</p>
    <div class="switch-row">
      <span class="switch-copy"><span>空间路径</span><small>${esc(space.slug)}</small></span>
      <button type="button" class="btn btn-ghost" data-x="slug"${locked ? ' disabled' : ''}>编辑路径…</button>
    </div>
    <label class="sort-pick" for="ss-sort">
      <span>排序</span>
      <select id="ss-sort" title="侧栏与总览的页面顺序"${locked ? ' disabled' : ''}>
        ${SORT_KEYS.map(k => `<option value="${k}"${k === (space.sort ?? DEFAULT_SORT) ? ' selected' : ''}>${SORT_LABELS[k]}</option>`).join('')}
      </select>
    </label>
    <label class="switch-row" for="ss-recommend">
      <span class="switch-copy">
        <span>自动按顺序推荐其他文章</span>
        <small>在文章底部显示上一篇 / 下一篇卡片</small>
      </span>
      <input type="checkbox" id="ss-recommend"${space.recommend ? ' checked' : ''}${locked ? ' disabled' : ''}>
      <span class="switch-ui" aria-hidden="true"></span>
    </label>
    ${space.builtIn ? '' : `<div class="switch-row">
      <span class="switch-copy"><span>空间锁定</span><small>锁定后内容仍可阅读，修改需先解锁</small></span>
      <button type="button" class="btn btn-ghost" data-x="lock">${space.locked ? '解锁空间…' : '锁定空间…'}</button>
    </div>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" data-x="no">关闭</button>
      <button class="btn btn-primary" data-x="ok"${locked ? ' disabled' : ''}>保存</button>
    </div>`);
  const sel = $('#ss-sort', m) as HTMLSelectElement;
  const rec = $('#ss-recommend', m) as HTMLInputElement;
  let settled = false;
  const finish = async save => {
    if (settled) return;
    settled = true;
    const pick = sel.value;
    // Send only what changed: an untouched field must not be rewritten (the default sort is
    // stored as `null`, not as the current default value), and an empty change skips the request.
    const changes: { sort?: SortKey | null; recommend?: boolean } = {};
    if (pick !== (space.sort ?? DEFAULT_SORT)) changes.sort = pick === DEFAULT_SORT ? null : (pick as SortKey);
    if (rec.checked !== !!space.recommend) changes.recommend = rec.checked;
    closeModal();
    // Keep the sort-only message other suites and the toast copy rely on; the switch gets the
    // broader wording because the same save may have touched two fields.
    if (save) await saveSpaceSettings(space, changes, changes.recommend === undefined ? '排序已更新 ✓' : '空间设置已更新 ✓');
  };
  $('[data-x=no]', m).onclick = () => finish(false);
  $('[data-x=ok]', m).onclick = () => finish(true);
  const openSubflow = (flow: () => void) => {
    if (sel.value !== (space.sort ?? DEFAULT_SORT) || rec.checked !== !!space.recommend) {
      toast('请先保存或放弃空间设置的更改');
      return;
    }
    finish(false);
    flow();
  };
  const lockButton = m.querySelector('[data-x=lock]') as HTMLButtonElement | null;
  if (lockButton) lockButton.onclick = () => openSubflow(() => lockSpaceFlow(space));
  $('[data-x=slug]', m).onclick = () => openSubflow(() => slugSpaceFlow(space));
  activeModalDone = () => finish(false);
}

async function slugSpaceFlow(space) {
  if (!space || pageContentLocked(space)) return;
  if (!S.authed) {
    showLoginDialog({ setup: S.authSetup, then: () => {
      const current = spaceBySlug(space.slug);
      if (current) slugSpaceFlow(current);
    } });
    return;
  }
  const value = await promptModal({
    title: '编辑空间路径',
    label: devSourceEditable(space)
      ? '仅限小写字母、数字、下划线。修改后旧空间链接及 Markdown 中硬编码的旧链接将失效。'
      : '仅限小写字母、数字、下划线。修改空间路径后，旧链接将失效。',
    value: space.slug,
    placeholder: 'my_space',
    ok: '保存',
  });
  if (value === null || value === space.slug) return;
  const ns = normalizeSlugInput(value);
  if (!ns) { toast('空间路径只能含小写字母、数字、下划线'); return; }
  try {
    const old = space.slug;
    const updated = await api<Space>('spaces/' + encodeURIComponent(old), {
      method: 'PUT', body: JSON.stringify({ slug: ns }),
    });
    // Pages reference their space by slug, so the whole tree has to follow the rename.
    const newSlug = updated.slug;
    S.pages.forEach(p => { if (p.space === old) p.space = newSlug; });
    if (S.page?.space === old) S.page.space = newSlug;
    const i = S.spaces.findIndex(s => s.slug === old);
    if (i >= 0) S.spaces[i] = updated;
    const wasCurrent = S.space?.slug === old;
    if (wasCurrent) S.space = updated;
    toast('空间路径已更新 ✓');
    // Update the address bar without re-routing: pages keep their own slug, so only
    // the leading space segment changes.
    if (S.page?.space === newSlug) {
      history.replaceState(null, '', canonicalPath(S.page.slug));
      renderArticle(S.page);
    } else if (wasCurrent) {
      history.replaceState(null, '', canonicalPath(newSlug));
      renderSpace(updated);
    } else {
      renderSidebar(el.search.value);
    }
  } catch (err) { toast(err.message, 3000); }
}

async function deleteSpaceFlow(space) {
  if (!space) return;
  const count = S.pages.filter(p => p.space === space.slug).length;
  const go = await confirmModal({
    title: `删除空间「${space.title}」？`,
    desc: devSourceEditable(space)
      ? `将删除内置空间的模板源码及全部 ${count} 个页面，此操作不可撤销。`
      : count ? `空间内 ${count} 个页面将一并删除，且无法恢复。` : '删除后无法恢复。',
    ok: '删除空间',
    danger: true,
  });
  if (!go) return;
  try {
    const r = await api<DeleteSpaceResponse>('spaces/' + encodeURIComponent(space.slug), { method: 'DELETE' });
    S.pages = S.pages.filter(p => p.space !== space.slug);
    S.spaces = S.spaces.filter(s => s.slug !== space.slug);
    toast(r.removedPages.length ? `已删除空间及 ${r.removedPages.length} 个页面` : '已删除空间');
    if (S.page && S.page.space === space.slug) { S.page = null; navigate('/'); }
    else if (S.space?.slug === space.slug) { S.space = null; navigate('/'); }
    else { renderSidebar(el.search.value); renderAuthUI(); }
  } catch (err) { toast(err.message, 3000); }
}

/* ============================================================
   Page operations
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
    const page = await api<Page>('pages', {
      method: 'POST',
      body: JSON.stringify({ title, space: spaceSlug, parent }),
    });
    S.pages.push({ ...page });
    // Keep the local record for `canonicalPath` even if the refetch below fails, then take the
    // server's copy: the new page's position depends on the space's sort key.
    await refreshTree();
    toast('已创建，开始编辑吧');
    S.pendingEdit = page.slug;
    navigate(canonicalPath(page.slug));
  } catch (err) { toast(err.message, 3000); }
}

async function renameFlow(pg: PageMeta | null = S.page) {
  if (!pg) return;
  const title = await promptModal({ title: '重命名页面', value: pg.title, ok: '保存' });
  if (title === null || !title || title === pg.title) return;
  try {
    await api('pages/' + encodeURIComponent(pg.slug), {
      method: 'PUT', body: JSON.stringify({ title }),
    });
    const i = S.pages.findIndex(p => p.slug === pg.slug);
    if (i >= 0) S.pages[i].title = title;
    await refreshTree();          // title_asc ordering and the bumped updatedAt come from the server
    if (S.page?.slug === pg.slug) { S.page.title = title; renderArticle(S.page); }
    else if (S.space) renderSpace(S.space);
    else renderSidebar(el.search.value);
    toast('已重命名 ✓');
  } catch (err) { toast(err.message, 3000); }
}

/** Normalize user-typed slug input: lowercase, underscores; empty when unusable. */
function normalizeSlugInput(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
}

async function slugFlow(pg: PageMeta | null = S.page) {
  if (!pg || pageContentLocked(spaceBySlug(pg.space))) return;
  if (!S.authed) {
    showLoginDialog({ setup: S.authSetup, then: () => {
      const current = pageBySlug(pg.slug);
      if (current) slugFlow(current);
    } });
    return;
  }
  const dev = devSourceEditable(spaceBySlug(pg.space));
  const prefix = 'doclight-default-';
  const initial = dev && pg.slug.startsWith(prefix) ? pg.slug.slice(prefix.length) : pg.slug;
  const value = await promptModal({
    title: '编辑页面路径',
    label: dev
      ? '仅限小写字母、数字、下划线，对应模板源文件名；修改后旧链接将失效。'
      : '仅限小写字母、数字、下划线。修改页面路径后，旧链接将失效。',
    value: initial,
    placeholder: 'my_page_1',
    ok: '保存',
  });
  if (value === null || value === initial) return;
  const ns = normalizeSlugInput(value);
  if (!ns) { toast('页面路径只能含小写字母、数字、下划线'); return; }
  try {
    const old = pg.slug;
    const updated = await api<Page>('pages/' + encodeURIComponent(old), {
      method: 'PUT', body: JSON.stringify({ slug: ns }),
    });
    const newSlug = updated.slug;
    S.pages.forEach(p => { if (p.parent === old) p.parent = newSlug; });
    const i = S.pages.findIndex(p => p.slug === old);
    if (i >= 0) { S.pages[i].slug = newSlug; S.pages[i].updatedAt = updated.updatedAt; }
    await refreshTree();          // slug is the order's tie-break, so the rank can move
    toast('页面路径已更新 ✓');
    if (S.page?.slug === old) { S.page = updated; navigate(canonicalPath(newSlug)); }
    else if (S.space) renderSpace(S.space);
    else renderSidebar(el.search.value);
  } catch (err) { toast(err.message, 3000); }
}

async function moveFlow(pg: PageMeta | null = S.page) {
  if (!pg) return;
  const banned = new Set([pg.slug, ...descendantSlugsOf(pg.slug)]);
  const sourceBuiltIn = !!spaceBySlug(pg.space)?.builtIn;
  const options = [];
  S.spaces.forEach(sp => {
    const targetBuiltIn = !!sp.builtIn;
    if (pageContentLocked(sp) && !devSourceEditable(sp)) return;
    options.push({ v: 's:' + sp.slug, label: '📁 ' + sp.title + '（顶层）' });
    // Ordinary pages can only enter the built-in space at the top level: source page slugs are
    // their own file names, so a nested target would need a second slug namespace.
    if (!sourceBuiltIn && targetBuiltIn) return;
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
    <p class="desc">可选择目标空间（顶层）或空间内的某个页面（其子页面）。普通页面移入内置空间时只能放在顶层。URL 会随新位置变化，旧链接自动规范化跳转。</p>
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
      const updated = await api<Page>('pages/' + encodeURIComponent(pg.slug), {
        method: 'PUT',
        // Staying inside the same space only needs the parent; moving across spaces sends both.
        body: JSON.stringify(toSpace === pg.space
          ? { parent: toParent }
          : { space: toSpace, parent: toParent }),
      });
      const i = S.pages.findIndex(p => p.slug === pg.slug);
      if (i >= 0) { S.pages[i].space = updated.space; S.pages[i].parent = updated.parent; }
      // The moved page kept its old array slot, which reflects the *source* space's order; only
      // the server puts it in the right place among its new siblings.
      await refreshTree();
      toast('已移动 ✓');
      if (S.page?.slug === pg.slug) { S.page = updated; navigate(canonicalPath(updated.slug)); }
      else { renderSidebar(el.search.value); if (S.space) renderSpace(S.space); }
    } catch (err) { toast(err.message, 3000); }
  };
  $('[data-x=no]', m).onclick = () => finish(false);
  $('[data-x=ok]', m).onclick = () => finish(true);
  activeModalDone = () => finish(false);
}

async function deleteFlow(pg: PageMeta | null = S.page) {
  if (!pg) return;
  const kidCount = descendantSlugsOf(pg.slug).size;
  const dev = devSourceEditable(spaceBySlug(pg.space));
  if (dev && S.spaces.some(space => space.home === pg.slug)) {
    toast('此页面是空间主页，删除后会同时清除主页设置', 4000);
  }
  const go = await confirmModal({
    title: `删除「${pg.title}」？`,
    desc: `${kidCount ? `将连带删除其下 ${kidCount} 个子页面` : ''}${dev ? `${kidCount ? '，' : ''}并同步删除模板源码` : ''}，删除后无法恢复。`,
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

function dispatchPageAction(action: string, page: PageMeta | null = S.page): void {
  if (!page) return;
  if (pageContentLocked(spaceBySlug(page.space))) { toast('空间已锁定，请先解锁'); return; }
  switch (action) {
    case 'child': createPageFlow(page.space, page.slug); break;
    case 'rename': renameFlow(page); break;
    case 'slug': slugFlow(page); break;
    case 'move': moveFlow(page); break;
    case 'delete': deleteFlow(page); break;
  }
}

/* ============================================================
   Views: space overview / space index / article
   ============================================================ */
function renderHome() {
  destroySourceEditor();
  S.page = null; S.space = null;
  document.title = 'DocLight · 空间总览';
  el.crumb.textContent = '';
  el.article.classList.remove('is-reading');
  el.article.hidden = true;
  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = true;
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  if (builtInConflict) {
    el.empty.hidden = true;
    el.article.innerHTML = `<div role="alert"><h1>内置空间名称冲突</h1><p>${esc(builtInConflictMessage)}</p><p>处理完成后请重新加载页面。</p></div>`;
    el.article.hidden = false;
    renderAuthUI();
    renderSidebar();
    return;
  }
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
    return `<a class="card" data-nav href="${esc(canonicalPath(sp.slug))}">
              <span class="t">${esc(sp.title)}</span>
              ${sp.desc ? `<span class="d">${esc(sp.desc)}</span>` : ''}
              <span class="s">${sp.builtIn ? `<span class="lock-badge">${devSourceEditable(sp) ? '开发者模式：可编辑模板源码' : '🔒 永久只读'}</span> · ` : sp.locked ? '<span class="lock-badge">🔒 已锁定</span> · ' : ''}${n ? n + ' 个页面 · ' : ''}${sp.builtIn ? '随应用更新' : `更新于 ${relTime(sp.updatedAt)}`}</span>
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

// A query parameter distinguishes a page's child-card index from the page itself.
const childCardsPath = (slug: string) => `${canonicalPath(slug)}?view=children`;

function cardIndexParent(space: Space): PageMeta | null {
  if (new URLSearchParams(location.search).get('view') !== 'children') return null;
  const path = withoutBase(location.pathname);
  if (!path) return null;
  let last: string;
  try { last = decodeURIComponent(path.split('/').filter(Boolean).at(-1) || ''); }
  catch { return null; }
  const page = pageBySlug(last) as PageMeta | null;
  return page && page.space === space.slug && canonicalPath(page.slug) === location.pathname ? page : null;
}

function renderSpace(space) {
  destroySourceEditor();
  S.page = null; S.space = space;
  const parent = cardIndexParent(space);
  if (!parent && new URLSearchParams(location.search).get('view') === 'children'
      && location.pathname !== canonicalPath(space.slug)) {
    history.replaceState(null, '', childCardsPath(space.slug));
  }
  collapsedSet.delete('s:' + space.slug);   // 进入空间索引时展开
  document.title = (parent ? `${parent.title}的子页面 · ${space.title}` : space.title) + ' · DocLight';
  el.crumb.textContent = parent ? parent.title : space.title;
  el.article.classList.remove('is-reading');
  el.editWrap.hidden = true;
  el.toolbarWrap.hidden = true;
  el.empty.hidden = true;
  el.clusterView.hidden = true;
  el.clusterEdit.hidden = true;
  el.dirtyPill.hidden = true;
  el.editor.innerHTML = '';

  const childrenByParent = new Map<string | null, PageMeta[]>();
  for (const page of S.pages as PageMeta[]) {
    if (page.space !== space.slug) continue;
    const parent = page.parent || null;
    const siblings = childrenByParent.get(parent) || [];
    siblings.push(page);
    childrenByParent.set(parent, siblings);
  }
  const pages = (childrenByParent.get(parent?.slug || null) || []).filter(p => p.slug !== parent?.slug);
  const path = parent ? chainOf(parent.slug) : [];
  const crumbs = parent ? path.map((node, index) => index === path.length - 1
    ? `<span class="cur">${esc(node.title)}的子页面</span>`
    : `<a data-nav href="${esc(childCardsPath(node.slug))}">${esc(node.title)}</a>`).join('<span aria-hidden="true"> / </span>')
    : `<span class="cur">${esc(space.title)}</span>`;
  // Manual ordering is a write: locked spaces and the read-only built-in template get no grips.
  const canSort = !pageContentLocked(space) || devSourceEditable(space);
  const cards = pages.map(p => {
    const children = (childrenByParent.get(p.slug) || []).filter(child => child.slug !== p.slug);
    return `<div class="card space-page-card" data-slug="${esc(p.slug)}" draggable="false">
              ${canSort ? `<span class="card-grip" role="button" aria-label="拖动排序" title="拖动排序"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="3.5" r="1.25"/><circle cx="10" cy="3.5" r="1.25"/><circle cx="6" cy="8" r="1.25"/><circle cx="10" cy="8" r="1.25"/><circle cx="6" cy="12.5" r="1.25"/><circle cx="10" cy="12.5" r="1.25"/></g></svg></span>` : ''}
              <a class="card-link" data-nav href="${esc(canonicalPath(p.slug))}" draggable="false">
                <span class="t">${esc(p.title)}</span>
                <span class="s">${children.length ? children.length + ' 个子页 · ' : ''}${space.builtIn ? '随应用更新' : `更新于 ${relTime(p.updatedAt)}`}</span>
              </a>
              ${children.length ? `<a class="card-expand" data-nav href="${esc(childCardsPath(p.slug))}" aria-label="查看${esc(p.title)}的子页面">查看 ${children.length} 个子页面 <span aria-hidden="true">→</span></a>` : ''}
            </div>`;
  }).join('');

  el.article.innerHTML =
    `<div class="meta-row"><nav class="crumbs" aria-label="页面层级">${crumbs}</nav><span class="sep">·</span>
       <span id="sp-slug" class="slug-chip">#${esc(space.slug)}</span>${devSourceEditable(space) ? '<span class="lock-badge">开发者模式：可编辑模板源码</span>' : pageContentLocked(space) ? `<span class="lock-badge">🔒 ${space.builtIn ? '内置空间，永久只读' : '空间已锁定，只读'}</span>` : ''}
     </div>
     <div class="space-head">
       <div>
         <h1>${parent ? `${esc(parent.title)}的子页面` : esc(space.title)}</h1>
         ${!parent && space.desc ? `<p class="space-desc">${esc(space.desc)}</p>` : ''}
       </div>
       <div class="space-acts"${space.builtIn && !devSourceEditable(space) ? ' hidden' : ''}>
         <label class="sort-pick"${!canSort ? ' hidden' : ''}>
           <span>排序</span>
           <select id="sp-sort" title="侧栏与总览的页面顺序">
             ${SORT_KEYS.map(k => `<option value="${k}"${k === (space.sort ?? DEFAULT_SORT) ? ' selected' : ''}>${SORT_LABELS[k]}</option>`).join('')}
           </select>
         </label>
         <label class="switch-inline" title="自动按顺序推荐其他文章：在文章底部显示上一篇 / 下一篇"${!canSort ? ' hidden' : ''}>
           <span>启用推荐</span>
           <input type="checkbox" id="sp-recommend"${space.recommend ? ' checked' : ''}>
           <span class="switch-ui" aria-hidden="true"></span>
         </label>
         <button class="btn btn-new" id="sp-add"${!canSort ? ' hidden' : ''}>＋ ${parent ? '新建子页面' : '新建页面'}</button>
         ${space.builtIn && !devSourceEditable(space) ? '' : '<button class="btn btn-ghost" id="sp-settings">空间设置</button>'}
         <button class="btn btn-ghost" id="sp-rename"${!canSort ? ' hidden' : ''}>重命名</button>
         ${space.builtIn && !devSourceEditable(space) ? '' : `<button class="btn btn-ghost danger-text" id="sp-delete"${!canSort ? ' hidden' : ''}>删除空间</button>`}
       </div>
     </div>
     <div class="cards"${parent ? ` data-parent="${esc(parent.slug)}"` : ''}>${cards}</div>
     ${pages.length ? '' : `<p class="list-empty" style="padding:30px 0">${parent ? '此页面还没有子页面。' : pageContentLocked(space) ? '此空间还没有页面。' : '此空间还没有页面，点击右上角「新建页面」开始创作。'}</p>`}`;

  el.article.hidden = false;
  decorate(el.article);
  $('#sp-sort').addEventListener('change', (e) => setSpaceSort(space, (e.target as HTMLSelectElement).value));
  // Same setting as the modal switch, offered where the sort picker already lives.
  $('#sp-recommend').addEventListener('change', (e) =>
    saveSpaceSettings(space, { recommend: (e.target as HTMLInputElement).checked }));
  $('#sp-settings')?.addEventListener('click', () => spaceSettingsFlow(space));
  $('#sp-add').addEventListener('click', () => createPageFlow(space.slug, parent?.slug || null));
  $('#sp-rename').addEventListener('click', () => renameSpaceFlow(space));
  $('#sp-delete')?.addEventListener('click', () => deleteSpaceFlow(space));
  const article = el.article as HTMLElement;
  if (canSort) {
    article.querySelectorAll<HTMLElement>('.cards').forEach(container => {
      if ([...container.children].filter(child => child.classList.contains('space-page-card')).length > 1) {
        setupCardDrag(space, container);
      }
    });
  }
  renderAuthUI();
  renderSidebar(el.search.value);
}

/* ============================================================
   Manual card ordering (drag)
   ============================================================ */
const CARD_DRAG_THRESHOLD = 4;

/** Scroll a drag container near its vertical edges and recompute the drop target after each step. */
function createDragAutoScroller(container: HTMLElement, onScroll: (x: number, y: number) => void) {
  let x = 0, y = 0, frame = 0, lastTime = 0, remainder = 0, stopped = false;
  const speed = () => {
    const rect = container.getBoundingClientRect();
    const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    const edge = Math.min(56, (bottom - top) / 3);
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (edge <= 0 || maxScroll <= 0) return 0;
    if (y < top + edge && container.scrollTop > 0) return -Math.min(1, (top + edge - y) / edge);
    if (y > bottom - edge && container.scrollTop < maxScroll) return Math.min(1, (y - bottom + edge) / edge);
    return 0;
  };
  const tick = (time: number) => {
    frame = 0;
    if (stopped) return;
    const direction = speed();
    if (!direction) { lastTime = 0; remainder = 0; return; }
    const elapsed = lastTime ? Math.min(50, Math.max(0, time - lastTime)) : 1000 / 60;
    lastTime = time;
    if (remainder * direction < 0) remainder = 0;
    // Accumulate subpixel steps: browsers that round scrollTop must still move near the edge.
    remainder += direction * 18 * elapsed / (1000 / 60);
    const step = Math.trunc(remainder);
    if (step) {
      const before = container.scrollTop;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.max(0, Math.min(maxScroll, before + step));
      const moved = container.scrollTop - before;
      if (!moved) { lastTime = 0; remainder = 0; return; }
      remainder -= moved;
      onScroll(x, y);
    }
    if (!stopped && speed()) frame = requestAnimationFrame(tick);
    else { lastTime = 0; remainder = 0; }
  };
  return {
    update(nextX: number, nextY: number) {
      x = nextX; y = nextY;
      if (!stopped && !frame && speed()) frame = requestAnimationFrame(tick);
    },
    stop() {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/**
 * Pointer-driven reordering for the space index cards, in the spirit of Yuque's card lists: the
 * card lifts under the pointer, a dashed placeholder marks the drop slot and the other cards slide
 * aside. Mouse users can drag anywhere on the card; touch and pen start from the grip, because a
 * finger dragging the card body would fight page scrolling.
 *
 * Nothing is persisted until the pointer is released: the DOM is the preview, and the drop sends
 * the new slug order to the space API (switching the space to manual sort on the first drag).
 */
function setupCardDrag(space, container: HTMLElement) {
  const parentSlug = container.dataset.parent || null;
  const cardsIn = () => [...container.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && child.classList.contains('space-page-card'));
  let swallowClick = false;

  // A drag ends with a click on the link under the pointer; swallow exactly that one, and never let
  // a tap on the grip navigate.
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest?.('.cards') !== container) return;
    if (target.closest?.('.card-grip')) { e.preventDefault(); e.stopPropagation(); return; }
    if (!swallowClick) return;
    e.preventDefault();
    e.stopPropagation();
    swallowClick = false;
  }, true);

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest?.('.cards') !== container || target.closest?.('.card-expand')) return;
    const card = target.closest?.('.space-page-card[data-slug]') as HTMLElement | null;
    if (!card || card.parentElement !== container) return;
    const grip = target.closest?.('.card-grip');
    if (!grip && e.pointerType && e.pointerType !== 'mouse') return;
    if (grip) e.preventDefault();
    startDrag(e, card, grip);
  });

  function startDrag(e, card, grip) {
    const startX = e.clientX, startY = e.clientY;
    let active = false;
    let placeholder = null;
    let offsetX = 0, offsetY = 0;
    const scrollArea = container.closest('.scroll-area') as HTMLElement | null;
    const autoScroll = scrollArea ? createDragAutoScroller(scrollArea, (x, y) => placePlaceholder(x, y)) : null;

    const cleanup = (restore) => {
      autoScroll?.stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (placeholder) {
        if (restore) placeholder.replaceWith(card);
        else placeholder.remove();
        placeholder = null;
      }
      card.classList.remove('is-dragging');
      card.style.cssText = '';
      container.classList.remove('is-sorting');
      document.body.classList.remove('is-card-dragging');
      // If no click follows the drop, do not swallow the reader's next tap.
      window.setTimeout(() => { swallowClick = false; }, 400);
    };

    const animate = (mutate) => {
      const others = cardsIn().filter(el => el !== card);
      const before = others.map(el => el.getBoundingClientRect());
      mutate();
      others.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        const dx = before[i].left - rect.left;
        const dy = before[i].top - rect.top;
        if (!dx && !dy) return;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth;
        requestAnimationFrame(() => {
          el.style.transition = 'transform .18s cubic-bezier(.2, .7, .3, 1)';
          el.style.transform = '';
          window.setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 220);
        });
      });
    };

    const placePlaceholder = (x, y) => {
      if (!placeholder) return;
      let before = null;
      for (const el of cardsIn()) {
        if (el === card) continue;
        const rect = el.getBoundingClientRect();
        // Grid cards are laid out row-wise: inside a row compare x, otherwise compare y.
        const sameRow = y >= rect.top && y <= rect.bottom;
        const goesBefore = sameRow ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
        if (goesBefore) { before = el; break; }
      }
      if (before) {
        if (placeholder.nextElementSibling !== before) animate(() => container.insertBefore(placeholder, before));
      } else if (placeholder !== container.lastElementChild) {
        animate(() => container.appendChild(placeholder));
      }
    };

    const onMove = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < CARD_DRAG_THRESHOLD) return;
        active = true;
        const rect = card.getBoundingClientRect();
        offsetX = startX - rect.left;
        offsetY = startY - rect.top;
        placeholder = document.createElement('div');
        placeholder.className = 'card-placeholder';
        placeholder.style.width = rect.width + 'px';
        placeholder.style.height = rect.height + 'px';
        card.insertAdjacentElement('afterend', placeholder);
        card.style.width = rect.width + 'px';
        card.style.height = rect.height + 'px';
        card.classList.add('is-dragging');
        container.classList.add('is-sorting');
        document.body.classList.add('is-card-dragging');
        swallowClick = true;
        try { (grip || card).setPointerCapture?.(e.pointerId); } catch { /* optional */ }
      }
      ev.preventDefault();
      card.style.left = (ev.clientX - offsetX) + 'px';
      card.style.top = (ev.clientY - offsetY) + 'px';
      placePlaceholder(ev.clientX, ev.clientY);
      autoScroll?.update(ev.clientX, ev.clientY);
    };

    const onUp = (ev) => {
      if (!active) { cleanup(false); return; }
      // The placeholder marks where the card lands; read the resulting slug order before restoring it.
      const order: string[] = [];
      for (const child of container.children) {
        if (child === placeholder) order.push(card.dataset.slug);
        else if (child !== card && child instanceof HTMLElement && child.classList.contains('card')) order.push(child.dataset.slug);
      }
      cleanup(true);
      if (ev.type !== 'pointercancel' && order.length) {
        const current = spacePages(space.slug, null).map(p => p.slug);
        saveSpaceOrder(space, buildSpaceOrder(space.slug, parentSlug, order), buildSpaceOrder(space.slug, null, current));
      }
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
}

/** True when two orders list the same slugs in the same sequence. */
function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((slug, i) => slug === b[i]);
}

/**
 * Persist a manual order.
 *
 * A drop that lands the pages where they already were is a no-op for the reader, yet writing it
 * would still move the space's `updatedAt` and re-sort every list that keys off it — so it is
 * skipped and only a hint is shown.
 */
async function saveSpaceOrder(space, order, previous?: string[]) {
  if (previous && sameOrder(previous, order)) { toast('排序无变化'); return; }
  const changed = { order } as { sort?: SortKey; order: string[] };
  if (space.sort !== 'manual') changed.sort = 'manual';
  try {
    const updated = await api<Space>('spaces/' + encodeURIComponent(space.slug), {
      method: 'PUT', body: JSON.stringify(changed),
    });
    const i = S.spaces.findIndex(s => s.slug === space.slug);
    if (i >= 0) S.spaces[i] = updated;
    if (S.space?.slug === space.slug) S.space = updated;
    await refreshTree();
    if (S.space?.slug === space.slug) renderSpace(S.space);
    else renderSidebar(el.search.value);
    toast('排序已更新 ✓');
  } catch (err) {
    toast(err.message, 3000);
    if (S.space?.slug === space.slug) renderSpace(S.space);
    else renderSidebar(el.search.value);
  }
}

/* ============================================================
   Manual ordering from the sidebar
   ============================================================ */
const SIDEBAR_DRAG_THRESHOLD = 4;

/** Full DFS order of a space with one sibling group reordered, so the API gets a complete list. */
function buildSpaceOrder(spaceSlug, parentSlug, siblingSlugs) {
  const order = [];
  const seen = new Set<string>();
  const walk = (parent) => {
    const kids = (parent || null) === (parentSlug || null)
      ? siblingSlugs.map(slug => pageBySlug(slug)).filter(Boolean)
      : spacePages(spaceSlug, parent);
    for (const kid of kids) {
      if (seen.has(kid.slug)) continue;
      seen.add(kid.slug);
      order.push(kid.slug);
      walk(kid.slug);
    }
  };
  walk(null);
  return order;
}

/**
 * Drag reordering in the sidebar.
 *
 * The sidebar is too narrow for a floating card, so the preview is an overlay insertion line
 * (a two-pixel accent rule with a circular knob) plus a highlighted target row; a small ghost chip
 * follows the pointer for context. Only siblings (same parent) are considered, so a drop never
 * changes the tree structure — moving a page to a different parent stays in the row menu.
 *
 * A drag only starts from the row's grip handle. Pressing the row itself stays a normal link tap,
 * which keeps the browser's own long-press link menu out of the gesture on touch devices.
 */
function setupSidebarDrag() {
  let swallowClick = false;

  el.list.addEventListener('click', (e) => {
    if (!swallowClick) return;
    e.preventDefault();
    e.stopPropagation();
    swallowClick = false;
  }, true);

  el.list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const grip = (e.target as HTMLElement).closest?.('.tree-grip');
    if (!grip) return;
    const row = grip.closest('.tree-row') as HTMLElement | null;
    if (!row || !row.dataset.slug) return;
    const space = spaceBySlug(row.dataset.space);
    if (!space || (pageContentLocked(space) && !devSourceEditable(space))) return;
    startDrag(e, row, space);
  });

  // The grip sits inside the row link, so keep the link callout from hijacking a slow press.
  el.list.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest?.('.tree-grip')) e.preventDefault();
  });

  function startDrag(e, row, space) {
    const page = pageBySlug(row.dataset.slug);
    if (!page) return;
    const startX = e.clientX, startY = e.clientY;
    let active = false;
    let ghost = null;
    let marker = null;
    let targetRow = null;
    let dropBefore = false;
    let lastX = startX, lastY = startY;
    const autoScroll = createDragAutoScroller(el.list as HTMLElement, (x, y) => placeMarker(x, y));

    const touchBlocker = (ev) => { if (active) ev.preventDefault(); };
    // A slow press on the handle can still raise the browser's callout mid-drag; suppress it while
    // the gesture owns the pointer.
    const blockMenu = (ev) => { if (active) ev.preventDefault(); };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('touchmove', touchBlocker);
      document.removeEventListener('contextmenu', blockMenu, true);
      autoScroll.stop();
      if (ghost) { ghost.remove(); ghost = null; }
      if (marker) { marker.remove(); marker = null; }
      if (highlightRow) { highlightRow.classList.remove('is-drop-target'); highlightRow = null; }
      row.classList.remove('is-dragging');
      document.body.classList.remove('is-row-dragging');
      window.setTimeout(() => { swallowClick = false; }, 400);
    };

    const activate = () => {
      active = true;
      swallowClick = true;
      row.classList.add('is-dragging');
      document.body.classList.add('is-row-dragging');
      ghost = document.createElement('div');
      ghost.className = 'tree-drag-ghost';
      ghost.textContent = page.title;
      document.body.appendChild(ghost);
      marker = document.createElement('div');
      marker.className = 'tree-drop';
      marker.setAttribute('aria-hidden', 'true');
      el.list.appendChild(marker);

    };

    let highlightRow = null;

    const placeMarker = (x, y) => {
      if (!marker) return;
      const parent = page.parent || '';
      const siblings = [...el.list.querySelectorAll('.tree-row')]
        .map(node => node as HTMLElement)
        .filter(r => r !== row && r.dataset.space === space.slug && (r.dataset.parent || '') === parent);
      if (!siblings.length) { targetRow = null; marker.hidden = true; return; }
      targetRow = null;
      dropBefore = false;
      for (const candidate of siblings) {
        const rect = candidate.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { targetRow = candidate; dropBefore = true; break; }
      }
      if (!targetRow) {
        targetRow = siblings[siblings.length - 1];
        dropBefore = false;
      }
      // After the last sibling, the line belongs after that sibling's whole open subtree.
      let edge = targetRow;
      if (!dropBefore) {
        const depth = Number(targetRow.dataset.depth || 0);
        for (;;) {
          const next = edge.nextElementSibling as HTMLElement | null;
          if (!next || !next.classList.contains('tree-row') || next.dataset.space !== space.slug ||
              Number(next.dataset.depth || 0) <= depth) break;
          edge = next;
        }
      }
      if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
      // Yuque-style overlay: the list does not reflow while dragging. The line floats on the row
      // boundary and the row it would land against is highlighted.
      const listRect = el.list.getBoundingClientRect();
      const anchorEl = targetRow.querySelector('.page-item');
      const rowRect = targetRow.getBoundingClientRect();
      const edgeRect = dropBefore ? rowRect : (edge as HTMLElement).getBoundingClientRect();
      const indent = anchorEl ? anchorEl.getBoundingClientRect().left - listRect.left : 24;
      const left = Math.max(12, indent - 2);
      marker.hidden = false;
      marker.style.top = (dropBefore ? edgeRect.top : edgeRect.bottom) - listRect.top + el.list.scrollTop - 1 + 'px';
      marker.style.left = left + 'px';
      marker.style.width = Math.max(24, listRect.width - left - 10) + 'px';
      if (highlightRow !== edge) {
        if (highlightRow) highlightRow.classList.remove('is-drop-target');
        highlightRow = edge as HTMLElement;
        highlightRow.classList.add('is-drop-target');
      }
    };

    const onMove = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SIDEBAR_DRAG_THRESHOLD) return;
        activate();
      }
      ev.preventDefault();
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (ghost) { ghost.style.left = lastX + 'px'; ghost.style.top = lastY + 'px'; }
      placeMarker(lastX, lastY);
      autoScroll.update(lastX, lastY);
    };

    const onUp = (ev) => {
      if (!active) { cleanup(); return; }
      // `spacePages`/`buildSpaceOrder` take `null` for the root level; the DOM dataset stores ''.
      const parent = page.parent || null;
      const siblings = spacePages(space.slug, parent).map(p => p.slug).filter(slug => slug !== page.slug);
      let index = siblings.length;
      const targetSlug = targetRow && targetRow.dataset.slug;
      const at = targetSlug ? siblings.indexOf(targetSlug) : -1;
      if (at >= 0) index = dropBefore ? at : at + 1;
      siblings.splice(index, 0, page.slug);
      const order = buildSpaceOrder(space.slug, parent, siblings);
      const current = buildSpaceOrder(space.slug, null, spacePages(space.slug, null).map(p => p.slug));
      cleanup();
      if (ev.type !== 'pointercancel' && order.length > 1) saveSpaceOrder(space, order, current);
    };

    // The grip sets `touch-action: none`, so a touch drag never scrolls the drawer; the blockers
    // stay as a second line of defence for browsers that still emit a native gesture.
    document.addEventListener('touchmove', touchBlocker, { passive: false });
    document.addEventListener('contextmenu', blockMenu, true);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
}

async function openPage(slug: string): Promise<void> {
  let page: Page;
  try {
    page = await api<Page>('pages/' + encodeURIComponent(slug));
  } catch (err) {
    if (isBuiltInConflict(err)) return;
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
   Routing (real paths: /space/page/...)
   ============================================================ */
function notFoundThenHome() {
  toast('路径不存在，已返回空间总览');
  history.replaceState(null, '', withBase('/'));
  renderHome();
}

async function route() {
  if (builtInConflict) { renderHome(); return; }
  const pathname = withoutBase(location.pathname);
  if (pathname === null) { notFoundThenHome(); return; }
  if (pathname === '/spaces' || pathname === '/spaces/') {
    renderHome();
    return;
  }
  let segs: string[];
  try { segs = pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { notFoundThenHome(); return; }
  if (!segs.length) { renderHome(); return; }

  const space = spaceBySlug(segs[0]);
  if (!space) {
    // Legacy page path (this slug is now a page inside some space) → redirect to the canonical URL
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
    if (new URLSearchParams(location.search).get('view') !== 'children' && !devSourceEditable(space) && space.home && pageBySlug(space.home)) { await openPage(space.home); return; }
    renderSpace(space);
    return;
  }

  // Deep link: page chain inside a space
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
  if (new URLSearchParams(location.search).get('view') === 'children') {
    renderSpace(space);
    $('.scroll-area')?.scrollTo?.({ top: 0 });
    return;
  }
  await openPage(node.slug);
}

function navigate(path) {
  if (path === '/') path = withBase('/');
  if (location.pathname + location.search + location.hash === path) { route(); return; }
  history.pushState(null, '', path);
  route();
}
window.addEventListener('popstate', route);

// The shell is shared with root deployments, so fix its home link at runtime.
$('.brand')?.setAttribute('href', withBase('/'));

// Intercept in-site links
document.addEventListener('click', e => {
  const a = e.target instanceof Element ? e.target.closest('a[data-nav]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.hasAttribute('download') || (a.getAttribute('target') && a.getAttribute('target') !== '_self')) return;
  e.preventDefault();
  const go = () => navigate(a.getAttribute('href') || '/');
  if (S.dirty && !el.editWrap.hidden) {
    confirmModal({ title: '有未保存的修改', desc: '要在离开前保存吗？', ok: '保存并离开' })
      .then(yes => { if (yes) saveDoc().then(() => { if (!S.dirty) go(); }); else go(); });
    return;
  }
  go();
});

/* ============================================================
   Global event bindings
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

$('#mode-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setEditMode(btn.dataset.mode as EditMode);
});

$('#menu-page').addEventListener('click', e => {
  const act = e.target.closest('.menu-item')?.dataset.act;
  if (!act) return;
  closeMenus(null);
  dispatchPageAction(act);
});

// Sidebar inline menu (page / space)
rowMenu.addEventListener('click', e => {
  const act = e.target.closest('.menu-item')?.dataset.act;
  if (!act) return;
  const kind = rowMenu.dataset.kind;
  const slug = rowMenu.dataset.slug;
  rowMenu.hidden = true;
  if (kind === 'space') {
    const sp = spaceBySlug(slug);
    if (!sp) return;
    if (pageContentLocked(sp) && act !== 'settings') return;
    if (act === 'rename') renameSpaceFlow(sp);
    if (act === 'settings') spaceSettingsFlow(sp);
    if (act === 'delete') deleteSpaceFlow(sp);
  } else {
    const pg = pageBySlug(slug);
    if (!pg) return;
    dispatchPageAction(act, pg);
  }
});

// Theme menu
$$('#menu-theme .menu-item').forEach(b =>
  b.addEventListener('click', () => { applyTheme(b.dataset.pref); closeMenus(null); }));

document.addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target?.closest('.dropdown-wrap') && !target?.closest('.row-menu')) closeMenus(null);
});

$('#title-input').addEventListener('input', markDirty);
el.editor.addEventListener('input', markDirty);
// Global shortcuts
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

// Mobile drawer
function toggleDrawer(open) {
  document.body.classList.toggle('side-open', open);
  el.scrim.hidden = !open;
}
$('#btn-menu').addEventListener('click', () => toggleDrawer(!document.body.classList.contains('side-open')));
el.scrim.addEventListener('click', () => toggleDrawer(false));
window.addEventListener('resize', () => {
  if (innerWidth > 900) toggleDrawer(false);
  // On a narrower window, only re-clamp the effective width (the preference is kept and recovers when widened)
  applyReadingWidth(readingWidth);
  $('.reading-handle')?.setAttribute('aria-valuemax', String(readingMax()));
});

el.list.addEventListener('click', e => {
  if (e.target.closest('.page-item') || e.target.closest('.space-title')) toggleDrawer(false);
});
setupSidebarDrag();

/* ============================================================
   Boot
   ============================================================ */

/**
 * The server renders the official public-security badge as a remote image (the raw HTML an
 * audit inspects must contain only the official mark). If that host is unreachable the badge
 * would silently vanish, so swap in a drawn shield client-side. This is why the fallback is
 * attached here and not emitted by the server: it never appears in the response markup, so it
 * cannot be mistaken for the official badge during a filing check.
 */
function enhanceFilingBadges(): void {
  $$('img.sf-badge').forEach(img => {
    // A cached/broken image may have already fired `error` before this ran.
    const replace = () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'sf-badge');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.innerHTML =
        '<path d="M8 1.1 2.9 2.9v4.4c0 3.3 2.1 6.2 5.1 7.7 3-1.5 5.1-4.4 5.1-7.7V2.9L8 1.1z" fill="currentColor" opacity=".18"/>' +
        '<path d="M8 1.1 2.9 2.9v4.4c0 3.3 2.1 6.2 5.1 7.7 3-1.5 5.1-4.4 5.1-7.7V2.9L8 1.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
        '<path d="M5.8 8.1 7.4 9.7l2.9-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
      img.replaceWith(svg);
    };
    if (img.complete && img.naturalWidth === 0) replace();
    else img.addEventListener('error', replace, { once: true });
  });
}

(async function boot() {
  el.editor.dataset.placeholder = '这里空空如也……开始书写你的第一段文字吧 ✍️';
  enhanceFilingBadges();
  try {
    const tree = await api<TreeResponse>('tree');
    S.spaces = tree.spaces || [];
    S.pages = tree.pages || [];
  } catch (err) {
    builtInConflict = isBuiltInConflict(err);
    if (builtInConflict) {
      builtInConflictMessage = err.message || BUILT_IN_CONFLICT;
      $('#btn-new').hidden = true;
    }
    else toast('无法连接服务器：' + err.message, 4000);
    S.spaces = []; S.pages = [];
  }
  renderSidebar();
  await refreshAuthState();
  appBooted = true;
  await route();
})();
