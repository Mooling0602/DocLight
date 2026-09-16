#!/usr/bin/env node
/**
 * DocLight - lightweight TypeScript documentation site
 *
 *   npm start                 # auto-detect a free port and start
 *   PORT=8080 npm start       # start from the given port
 *
 * API:
 *   GET    /api/pages        page list (without content)
 *   GET    /api/pages/:slug  single page detail
 *   POST   /api/pages        create { title }
 *   PUT    /api/pages/:slug  update { title?, content? }
 *   DELETE /api/pages/:slug  delete
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

interface Space {
  slug: string;
  title: string;
  desc: string;
  home: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Page {
  slug: string;
  space: string;
  parent: string | null;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface Database {
  version: 3;
  spaces: Space[];
  pages: Page[];
}

interface AuthRecord {
  user: string | null;
  salt: string;
  iters: number;
  stored: string | null;
}

interface Session {
  user: string;
  exp: number;
}

type RequestBody = Record<string, unknown>;

// The compiled entry point lives in dist/, while public/ and data/ stay at the project root.
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pages.json');
const BODY_LIMIT = 1024 * 1024; // 1MB

/* ---------------------------------------------------------------- 数据层 */

function seedDb(): Database {
  const now = Date.now();
  return {
    version: 3,
    spaces: [
      { slug: 'default', title: '欢迎使用 DocLight', desc: 'DocLight 默认空间', home: 'welcome', createdAt: now, updatedAt: now },
    ],
    pages: [
    {
      slug: 'welcome',
      space: 'default',
      parent: null,
      title: '欢迎使用 DocLight',
      content: [
        '<h1>欢迎使用 DocLight ✦</h1>',
        '<p>这是一个<b>轻量的可视化文档站</b>：浏览器里直接排版，保存即刻生效。TypeScript 源码、浏览器单页应用与数据文件都在同一项目中。</p>',
        '<blockquote><p>设计理念 —— 简洁优雅、开箱即用；写作本身不该比写下的内容更费劲。</p></blockquote>',
        '<h2>它有什么</h2>',
        '<ul>',
        '  <li><b>可视化编辑</b>：所见即所得工具栏，标题、粗斜体、列表、引用、代码块一应俱全</li>',
        '  <li><b>深浅色适配</b>：自动跟随系统外观，也可手动切换并记住选择</li>',
        '  <li><b>TypeScript 构建</b>：首次执行 <code>npm install</code>，再用 <code>npm start</code> 编译并启动</li>',
        '  <li><b>自动找端口</b>：端口被占用时自动探测下一个空闲端口</li>',
        '</ul>',
        '<h2>三步上手</h2>',
        '<ol>',
        '  <li>点击右上角 <b>编辑</b> 进入编辑模式；</li>',
        '  <li>像使用字处理软件一样直接排版；</li>',
        '  <li>按 <code>Ctrl / ⌘ + S</code> 或点击 <b>保存</b> 即可发布。</li>',
        '</ol>',
        '<hr>',
        '<h2>样式一览</h2>',
        '<p>行内代码长这样：<code>npm run build</code>；代码块支持多行：</p>',
        '<pre><code>// 首次运行先安装依赖\nnpm install\nnpm start\n// → http://localhost:4173</code></pre>',
        '<p>准备好了？去看看<a href="#/guide">《可视化编辑指南》</a>吧。</p>',
      ].join('\n'),
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'guide',
      space: 'default',
      parent: null,
      title: '可视化编辑指南',
      content: [
        '<h1>可视化编辑指南</h1>',
        '<p>DocLight 的编辑器是「所见即所得」的——你排版的样子，就是读者看到的样子。</p>',
        '<h2>进入与退出</h2>',
        '<ul>',
        '  <li><b>编辑</b>：任意页面右上角点击「编辑」；</li>',
        '  <li><b>保存</b>：工具栏右侧按钮，或快捷键 <code>Ctrl / ⌘ + S</code>；</li>',
        '  <li><b>取消</b>：放弃本次修改；若有未保存改动会先向你确认。</li>',
        '</ul>',
        '<h2>工具栏说明</h2>',
        '<h3>段落样式</h3>',
        '<p>H1 / H2 / H3 将选中的段落转换为各级标题，「¶」恢复为普通段落。</p>',
        '<h3>文字样式</h3>',
        '<p><b>粗体</b>、<i>斜体</i>、<u>下划线</u>、<s>删除线</s>，以及行内代码 <code>like_this()</code>。</p>',
        '<h3>列表与引用</h3>',
        '<ul><li>无序 / 有序列表，<code>Tab</code> 增加缩进，<code>Shift+Tab</code> 减少。</li></ul>',
        '<blockquote><p>这就是引用块的效果，适合放提示或强调。</p></blockquote>',
        '<h3>对齐方式</h3>',
        '<p>居左 / 居中 / 居右，作用于光标所在段落；清除格式会一并重置对齐。</p>',
        '<h3>插入元素</h3>',
        '<ul>',
        '  <li><b>链接</b>：选中文字后点击，输入地址即可；外部链接自动在新标签页打开；</li>',
        '  <li><b>图片</b>：粘贴图片 URL，宽度自适应容器；</li>',
        '  <li><b>代码块 / 分隔线</b>：让版面更有层次。</li>',
        '</ul>',
        '<h2>常用快捷键</h2>',
        '<ul>',
        '  <li><code>Ctrl / ⌘ + S</code> —— 保存</li>',
        '  <li><code>Ctrl / ⌘ + B</code> / <code>I</code> / <code>U</code> —— 粗体 / 斜体 / 下划线</li>',
        '  <li><code>Ctrl / ⌘ + Z</code> —— 撤销</li>',
        '</ul>',
        '<h2>关于 slug</h2>',
        '<p>每个页面在创建时生成唯一的 slug 并<u>永久绑定</u>到链接，之后重命名标题也不会失效。</p>',
        '<hr>',
        '<p style="text-align:center;color:#8a8f9f">— 现在，去写下你的第一篇文档吧 —</p>',
      ].join('\n'),
      createdAt: now - 1,
      updatedAt: now - 1,
    },
    {
      slug: 'changelog',
      space: 'default',
      parent: null,
      title: '更新日志',
      content: [
        '<h1>更新日志</h1>',
        '<h2>v1.0.0 · 首发</h2>',
        '<ul>',
        '  <li>🎉 可视化编辑器：标题、文本样式、列表、引用、代码块、链接与图片</li>',
        '  <li>🌗 深浅色主题：跟随系统 + 手动三态切换，偏好本地记忆</li>',
        '  <li>📄 页面管理：新建、重命名、删除、侧栏搜索</li>',
        '  <li>🛡 服务端内容清洗，拦截脚本注入</li>',
        '  <li>🔌 TypeScript 构建，空闲端口自动探测</li>',
        '</ul>',
      ].join('\n'),
      createdAt: now - 2,
      updatedAt: now - 2,
    },
    ],
  };
}

function ensureData(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeDb(seedDb());
    console.log('· 已写入初始示例数据（v3 空间模型）→ data/pages.json');
  }
}

function descendantsOf(list: Page[], slug: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of list) {
      if (p.parent && !out.has(p.slug) && (out.has(p.parent) || p.parent === slug)) { out.add(p.slug); grew = true; }
    }
  }
  return out;
}
function readDb(): Database {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && raw.version === 3) return { version: 3, spaces: raw.spaces || [], pages: raw.pages || [] };
  } catch { /* fallthrough */ }
  console.log('· 数据非 v3 格式，已重置为初始示例数据（早期开发阶段，不做兼容）');
  const fresh = seedDb();
  writeDb(fresh);
  return fresh;
}
function writeDb(db: Database): void {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------------------------------------------------------- 内容清洗(XSS) */

function sanitizeHtml(html: unknown): string {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\/?\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])?\s*(?:javascript|vbscript):[^\s>]*/gi,
      (_m, attr, q) => `${attr}=${q ? q + '#' + q : '"#"'}`)
    .slice(0, 500 * 1024);
}

function randomToken(len = 7): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < len; i++) t += abc[Math.floor(Math.random() * abc.length)];
  return t;
}
const SLUG_RE = /^[a-z0-9_]{1,80}$/;
const RESERVED_SLUGS = new Set(['spaces']); // 系统关键字别名，不可被页面占用;

function slugify(title: unknown): string {
  // 语雀风：小写字母/数字/下划线；非英文标题回退随机 token
  const s = String(title || '').trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return s || randomToken();
}

/* ------------------------------------------------------------ HTTP 工具 */

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(res: ServerResponse, urlPath: string): void {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA 回退，支持 #/xxx 深链
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

/* --------------------------------------------------------------- 鉴权 */

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const KDF_ITERS = 100000;              // PBKDF2-SHA256 迭代次数
const SESSION_TTL = 7 * 86400e3;       // 会话滑动续期 7 天
const sessions = new Map<string, Session>(); // token -> { user, exp }
const nonces = new Map<string, number>();    // 登录挑战（一次性，60s）
const failLog = new Map<string, { n: number; ts: number }>(); // 登录失败限速（按 IP）

function readAuth(): AuthRecord | null {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function writeAuth(auth: AuthRecord): void { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 }); }
function ensureAuthRecord(): AuthRecord {
  let a = readAuth();
  if (!a) {
    a = { user: null, salt: crypto.randomBytes(16).toString('hex'), iters: KDF_ITERS, stored: null };
    writeAuth(a);
    console.log('· 已生成鉴权记录（等待首次初始化账号）');
  }
  return a;
}
function hmacStored(storedHex: string, nonce: string): string {
  return crypto.createHmac('sha256', Buffer.from(storedHex, 'hex')).update(nonce).digest('hex');
}
function ipOf(req: IncomingMessage): string { return req.socket.remoteAddress || 'unknown'; }
function rateLimited(req: IncomingMessage): boolean {
  const f = failLog.get(ipOf(req));
  return !!(f && f.n >= 8 && Date.now() - f.ts < 120e3);
}
function noteFail(req: IncomingMessage): void {
  const ip = ipOf(req);
  const f = failLog.get(ip) || { n: 0, ts: Date.now() };
  if (Date.now() - f.ts >= 120e3) { f.n = 0; f.ts = Date.now(); }
  f.n++; failLog.set(ip, f);
}
function parseSessionToken(req: IncomingMessage): string | null {
  const m = /(?:^|;\s*)dl_sess=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function getSession(req: IncomingMessage): { user: string; token: string } | null {
  const token = parseSessionToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(token); return null; }
  s.exp = Date.now() + SESSION_TTL; // 滑动续期
  return { user: s.user, token };
}
function issueSession(res: ServerResponse, user: string): void {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `dl_sess=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
  return json(res, 200, { ok: true, user });
}
function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of nonces) if (v < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const action = parts[2] || '';
  const a = ensureAuthRecord();

  if (req.method === 'GET' && action === 'state') {
    const sess = getSession(req);
    return json(res, 200, {
      mode: a.user ? 'ready' : 'setup',
      authed: !!sess,
      user: sess ? sess.user : (a.user || null), // 预填登录框用（挑战接口本就公开此名）
      salt: a.salt, iters: a.iters,
    });
  }

  if (req.method === 'GET' && action === 'challenge') {
    if (!a.user) return json(res, 400, { error: '请先完成账号初始化', needSetup: true });
    purgeExpired();
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now() + 60e3);
    return json(res, 200, { nonce, salt: a.salt, iters: a.iters, user: a.user });
  }

  if (req.method === 'POST' && action === 'setup') {
    if (a.user) return json(res, 403, { error: '账号已初始化，请直接登录' });
    const body = await readBody(req);
    const user = String(body.user || '').trim();
    const ks = String(body.ks || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(user)) return json(res, 400, { error: '用户名仅限字母、数字、下划线、连字符（≤40 位）' });
    if (!/^[a-f0-9]{64}$/.test(ks)) return json(res, 400, { error: '密钥格式非法' });
    a.user = user; a.stored = ks;
    writeAuth(a);
    console.log(`· 站长账号已初始化：${user}`);
    return issueSession(res, user);
  }

  if (req.method === 'POST' && action === 'login') {
    if (!a.user) return json(res, 400, { error: '请先完成账号初始化', needSetup: true });
    if (rateLimited(req)) return json(res, 429, { error: '尝试过于频繁，请两分钟后再试' });
    const body = await readBody(req);
    const nonce = String(body.nonce || '');
    const exp = nonces.get(nonce);
    if (!exp || Date.now() > exp) return json(res, 400, { error: '挑战已过期，请重试' });
    nonces.delete(nonce); // 一次性，防重放
    if (!a.stored) return json(res, 500, { error: '鉴权记录损坏，请重新初始化' });
    const expected = hmacStored(a.stored, nonce);
    const proof = String(body.proof || '');
    const ok = /^[a-f0-9]{64}$/.test(proof) &&
      crypto.timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
    if (!ok) { noteFail(req); return json(res, 401, { error: '用户名或密码错误' }); }
    failLog.delete(ipOf(req));
    return issueSession(res, a.user);
  }

  if (req.method === 'POST' && action === 'logout') {
    const sess = getSession(req);
    if (sess) sessions.delete(sess.token);
    res.setHeader('Set-Cookie', 'dl_sess=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not Found' });
}

/* --------------------------------------------------------------- 路由 */

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const parts = pathname.split('/').filter(Boolean); // ['api','pages',':slug?']
  const key = parts[1] || '';

  /* 鉴权端点 */
  if (key === 'auth') return handleAuth(req, res, parts);

  /* 文档写操作需要登录（读取保持公开） */
  if ((key === 'pages' || key === 'spaces') && req.method !== 'GET') {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: '请先登录后再修改', needAuth: true });
  }

  const db = readDb();

  /* 全量树：空间 + 页面元信息 */
  if (req.method === 'GET' && key === 'tree' && parts.length === 2) {
    return json(res, 200, {
      spaces: db.spaces,
      pages: db.pages.map(({ content, ...meta }) => meta),
    });
  }

  /* ---- 空间 ---- */
  if (key === 'spaces') {
    if (req.method === 'POST' && parts.length === 2) {
      const body = await readBody(req);
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return json(res, 400, { error: '请提供空间名称' });
      const desc = String(body.desc || '').trim().slice(0, 200);
      const taken = (s: string) => db.pages.some(p => p.slug === s) || db.spaces.some(x => x.slug === s) || RESERVED_SLUGS.has(s);
      let slug = slugify(title);
      while (taken(slug)) slug = slugify(title) + '_' + randomToken(4);
      const now = Date.now();
      const space: Space = { slug, title, desc, home: null, createdAt: now, updatedAt: now };
      db.spaces.push(space);
      writeDb(db);
      return json(res, 201, space);
    }
    if (parts.length === 3) {
      const slug = decodeURIComponent(parts[2]);
      const idx = db.spaces.findIndex(s => s.slug === slug);
      if (req.method === 'PUT') {
        if (idx < 0) return json(res, 404, { error: '空间不存在' });
        const body = await readBody(req);
        if (body.title !== undefined) {
          const t = String(body.title).trim().slice(0, 120);
          if (!t) return json(res, 400, { error: '空间名称不能为空' });
          db.spaces[idx].title = t;
        }
        if (body.desc !== undefined) db.spaces[idx].desc = String(body.desc).trim().slice(0, 200);
        db.spaces[idx].updatedAt = Date.now();
        writeDb(db);
        return json(res, 200, db.spaces[idx]);
      }
      if (req.method === 'DELETE') {
        if (idx < 0) return json(res, 404, { error: '空间不存在' });
        const spaceSlug = db.spaces[idx].slug;
        const removedPages = db.pages.filter(p => p.space === spaceSlug).map(p => p.slug);
        db.pages = db.pages.filter(p => p.space !== spaceSlug);
        db.spaces.splice(idx, 1);
        writeDb(db);
        return json(res, 200, { ok: true, removedSpace: spaceSlug, removedPages });
      }
    }
  }

  /* ---- 页面 ---- */
  if (key === 'pages' && req.method === 'GET' && parts.length === 2) {
    return json(res, 200, db.pages.map(({ content, ...meta }) => meta));
  }
  if (key === 'pages' && parts.length === 3) {
    const slug = decodeURIComponent(parts[2]);
    const idx = db.pages.findIndex(p => p.slug === slug);

    if (req.method === 'GET') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      return json(res, 200, db.pages[idx]);
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      if (body.slug !== undefined) {
        const ns = String(body.slug || '').trim();
        if (!SLUG_RE.test(ns)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
        if (RESERVED_SLUGS.has(ns)) return json(res, 400, { error: '该 slug 为系统保留字' });
        if (ns !== slug && (db.pages.some(p => p.slug === ns) || db.spaces.some(s => s.slug === ns))) {
          return json(res, 400, { error: '该 slug 已被占用' });
        }
        if (ns !== slug) {
          db.pages.forEach(p => { if (p.parent === slug) p.parent = ns; });
          db.pages[idx].slug = ns;
          const sp = db.spaces.find(s => s.home === slug);
          if (sp) sp.home = ns;
        }
      }
      if (body.space !== undefined) {
        const ns = body.space || null;
        if (typeof ns !== 'string') return json(res, 400, { error: 'space 参数非法' });
        if (!db.spaces.some(s => s.slug === ns)) return json(res, 404, { error: '目标空间不存在' });
        const old = db.pages[idx].space;
        db.pages[idx].space = ns;
        const oldSp = db.spaces.find(s => s.slug === old);
        if (oldSp && oldSp.home === slug) oldSp.home = null;
      }
      if (body.parent !== undefined) {
        const parent = body.parent || null;
        if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
        if (parent === slug) return json(res, 400, { error: '不能移动到自身之下' });
        if (parent) {
          const pp = db.pages.find(p => p.slug === parent);
          if (!pp) return json(res, 404, { error: '目标父级不存在' });
          if (pp.space !== db.pages[idx].space) return json(res, 400, { error: '父级必须位于同一空间' });
          if (descendantsOf(db.pages, slug).has(parent)) return json(res, 400, { error: '不能移动到自己的子页面之下' });
        }
        db.pages[idx].parent = parent;
      }
      if (body.title !== undefined) {
        const t = String(body.title).trim().slice(0, 120);
        if (!t) return json(res, 400, { error: '标题不能为空' });
        db.pages[idx].title = t;
      }
      if (body.content !== undefined) db.pages[idx].content = sanitizeHtml(body.content);
      db.pages[idx].updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, db.pages[idx]);
    }
    if (req.method === 'DELETE') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      const doomed = [slug, ...descendantsOf(db.pages, slug)];
      db.pages = db.pages.filter(p => !doomed.includes(p.slug));
      const sp = db.spaces.find(s => s.home === slug);
      if (sp) sp.home = null;
      writeDb(db);
      return json(res, 200, { ok: true, removed: doomed });
    }
  }

  if (req.method === 'POST' && key === 'pages' && parts.length === 2) {
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return json(res, 400, { error: '请提供页面标题' });
    const space = String(body.space || '');
    if (!db.spaces.some(s => s.slug === space)) return json(res, 404, { error: '目标空间不存在' });
    const parent = body.parent === undefined ? null : body.parent;
    if (parent !== null && typeof parent !== 'string') return json(res, 400, { error: 'parent 参数非法' });
    if (parent) {
      const pp = db.pages.find(p => p.slug === parent);
      if (!pp) return json(res, 404, { error: '目标父级不存在' });
      if (pp.space !== space) return json(res, 400, { error: '父级必须位于同一空间' });
    }
    const taken = (s: string) => db.pages.some(p => p.slug === s) || db.spaces.some(x => x.slug === s) || RESERVED_SLUGS.has(s);
    let slug = slugify(title);
    const base = slug;
    while (taken(slug)) slug = base + '_' + randomToken(4);
    const page: Page = { slug, space, parent, title, content: '', createdAt: Date.now(), updatedAt: Date.now() };
    db.pages.push(page);
    writeDb(db);
    return json(res, 201, page);
  }

  return json(res, 404, { error: 'Not Found' });
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
  });

  Promise.resolve(pathname.startsWith('/api/') ? handleApi(req, res, pathname) : null)
    .catch((err: unknown) => {
      const error = err as { code?: number; message?: string };
      json(res, error.code || 500, { error: error.message || '服务器内部错误' });
    });

  if (!pathname.startsWith('/api/')) serveStatic(res, pathname);
}

/* ----------------------------------------------------- 空闲端口探测启动 */

function listen(server: Server, port: number, retriesLeft: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE' && retriesLeft > 0) resolve(listen(server, port + 1, retriesLeft - 1));
      else reject(err);
    });
    server.listen(port, () => resolve(port));
  });
}

async function main(): Promise<void> {
  ensureData();
  const startPort = Number(process.env.PORT) || 4173;
  const server = http.createServer(handler);
  try {
    const port = await listen(server, startPort, 50);
    try { fs.writeFileSync(path.join(ROOT, '.server.pid'), String(process.pid)); } catch { /* ignore */ }
    console.log(`\n  ✦ DocLight 文档站已就绪 (PID ${process.pid})`);
    console.log(`    本机访问  http://localhost:${port}`);
    console.log(`    数据文件  ${DATA_FILE}\n`);
  } catch (err) {
    console.error('启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
main();
