#!/usr/bin/env node
/**
 * DocLight - lightweight TypeScript documentation site
 *
 *   npm start                 # auto-detect a free port and start
 *   PORT=8080 npm start       # start from the given port
 *
 * Configuration (see src/config.ts): built-in defaults < doclight.toml < environment.
 * The file is <root>/doclight.toml unless DOCLIGHT_CONFIG points elsewhere. On first run
 * a fully commented template is written there so the options are discoverable in place —
 * it holds no active values, so the resolved configuration is unchanged; a malformed file
 * still aborts startup.
 *
 * Environment (temporary overrides; an existing variable always wins, empty clears):
 *   PORT                 starting TCP port (default 4173)
 *   DOCLIGHT_HOST        bind address (default: all interfaces)
 *   DOCLIGHT_DATA_DIR    writable data directory (default: <root>/data)
 *   DOCLIGHT_STRICT_PORT fail instead of scanning for the next free port
 *   DOCLIGHT_CONFIG      path to the TOML configuration file
 *
 * Pages are stored as Markdown files (`<dataDir>/pages/<slug>.md`, YAML front matter) with the
 * spaces in `<dataDir>/spaces.json`; see src/store.ts. A legacy single `pages.json` (v3 HTML or
 * v4 Markdown) is split into that layout on first start.
 *
 * API:
 *   GET    /api/pages        page list (without content)
 *   GET    /api/pages/:slug  single page detail (Markdown content)
 *   POST   /api/pages        create { title }
 *   PUT    /api/pages/:slug  update { title?, content?, slug?, space?, parent? }
 *   DELETE /api/pages/:slug  delete
 *   POST   /api/spaces       create { title, desc? }
 *   PUT    /api/spaces/:slug update { title?, desc?, slug? }
 *   DELETE /api/spaces/:slug delete
 *
 * Filing footer (see src/beian.ts), all optional:
 *   DOCLIGHT_ICP           ICP filing number, e.g. 浙ICP备12345678号-1
 *   DOCLIGHT_ICP_URL       override the filing portal link
 *   DOCLIGHT_POLICE        public security filing number, e.g. 京公网安备11010502030123号
 *   DOCLIGHT_POLICE_URL    override the public security portal link
 *   DOCLIGHT_COPYRIGHT     copyright line, e.g. © 2026 Mooling
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { injectFooter, readFooterOptions } from './beian.js';
import { loadConfig, ensureConfigFile } from './config.js';
import { htmlToMarkdown, sanitizeMarkdown } from './markdown.js';
import { readStore, writeStore, writeSpaces, mergeSpaces, storeExists, spacesIndexIsEmpty, seedFromTemplate, recoverStore } from './store.js';
import type { AppConfig } from './config.js';
import type { Database, Page, Space, WriteOptions } from './store.js';

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
// Configuration is resolved once, before anything depends on it: the TOML file (if any)
// plus environment overrides. A malformed file must abort startup rather than fall back
// silently, because that would hide the operator's mistake behind working defaults.
//
// The starter file is seeded first so a first run leaves an editable doclight.toml in
// place, making the options discoverable without a trip to the README. It is written
// only when the operator has no file at the default path, and never holds active values
// (every key is commented out), so it cannot change the resolved configuration.
const CONFIG: AppConfig = (() => {
  const seeded = ensureConfigFile({ root: ROOT });
  if (seeded) console.log(`· 已生成配置文件模板 → ${seeded}（默认全注释，按需取消注释）`);
  try {
    return loadConfig({ root: ROOT });
  } catch (err) {
    console.error('配置错误:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
// The Nix package ships in a read-only store path, so everything writable must be
// relocatable. `dataDir` defaults to the project layout and can be redirected to a
// persistent volume through the config file or DOCLIGHT_DATA_DIR.
const DATA_DIR = CONFIG.dataDir;
// Pages are stored as real Markdown files (`data/pages/<slug>.md`, YAML front matter) and the
// spaces as `data/spaces.json`; see src/store.ts. A single legacy `data/pages.json` (v3 or v4)
// is split into that layout on first start.
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'pages.json');
const TEMPLATE_DIR = path.join(ROOT, 'template');
const BODY_LIMIT = 1024 * 1024; // 1MB

/* ---------------------------------------------------------------- Data layer */

/** The shipped sample site, laid out like the store (template/spaces.json + template/pages/*.md). */
function seedDb(): Database {
  const seeded = seedFromTemplate(TEMPLATE_DIR);
  if (!seeded) {
    console.warn(`· 未找到示例数据 ${TEMPLATE_DIR}，将以空站点启动`);
    return { version: 4, spaces: [], pages: [] };
  }
  return seeded;
}

/**
 * Bring the data directory up to the Markdown-file layout on startup:
 *   1. a legacy `pages.json` is split into `spaces.json` + `pages/*.md` (HTML bodies converted);
 *   2. otherwise, a fresh store is seeded from the shipped sample.
 */
function ensureData(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // An index that parses but names no spaces cannot classify the pages: readStore would collapse
  // every one of them onto a synthetic fallback and the next write would persist that loss. When
  // pages exist the index is therefore rebuilt from them, exactly as for a missing index. A site
  // the user deliberately emptied has no pages, so it is left alone rather than re-seeded.
  if (spacesIndexIsEmpty(DATA_DIR)) {
    const repaired = recoverStore(DATA_DIR);
    if (repaired) {
      console.warn(`· ${path.join(DATA_DIR, 'spaces.json')} 不含任何空间，已按现有页面重建索引（页面文件未改动）`);
      writeSpaces(DATA_DIR, repaired.spaces);
      // A rebuilt index makes the store authoritative again, so any lingering legacy file is
      // retired here too — otherwise a later lost index would fall through to the legacy branch.
      retireLegacyFile();
      return;
    }
    // No pages to rebuild from. An empty index is consistent with a site the user emptied on
    // purpose, but if a legacy file is also present *it* is this site's real data — the index was
    // written empty and the pages never made it out of the single file. Retiring it here (which the
    // `storeExists` branch below would do, an empty-but-parseable index counting as a store) would
    // move the user's only copy aside unread and leave them looking at an empty site. A legacy file
    // beside its own backup is the stale-reappearance case, not this one, so it is left to below.
    if (fs.existsSync(LEGACY_DATA_FILE) && !fs.existsSync(LEGACY_DATA_FILE + '.bak')) {
      migrateLegacyFile();
      return;
    }
  }

  if (storeExists(DATA_DIR)) {
    // The store is authoritative. A legacy file left behind by an older version must be moved
    // out of the way: if `spaces.json` is ever lost, that stale snapshot would otherwise win the
    // legacy branch below and silently re-import pre-edit content over the live page files.
    retireLegacyFile();
    return;
  }

  // A legacy file sitting next to its own backup proves a migration already ran for this data
  // directory, so this copy is a stale re-appearance — the retire step failed, or the file was
  // copied back in. Migrating it would re-import pre-edit content over the live page files, so it
  // is retired instead (its bytes preserved) and the store is rebuilt from those files below.
  if (fs.existsSync(LEGACY_DATA_FILE) && fs.existsSync(LEGACY_DATA_FILE + '.bak')) {
    console.warn(`· ${path.basename(LEGACY_DATA_FILE)} 与已有备份并存，判定为迁移残留，将按页面文件恢复`);
    retireLegacyFile();
  } else if (fs.existsSync(LEGACY_DATA_FILE)) {
    // A legacy single file is the site's real data, so it is migrated first. Hand-written pages
    // already sitting in `pages/` survive this because a write only unlinks files the caller
    // declared removed, never every file the incoming db happens not to mention.
    migrateLegacyFile();
    return;
  }

  // With no legacy file, pages on disk mean the spaces index alone was lost. It is derived data
  // (every page carries its space in its front matter), so it is rebuilt from the pages rather
  // than papered over with the sample, which would overwrite any page sharing a sample's name.
  // Only the index is written: the page files are the source of truth and are left as they are.
  const recovered = recoverStore(DATA_DIR);
  if (recovered) {
    console.warn(`· 未找到 ${path.join(DATA_DIR, 'spaces.json')}，已按现有页面重建索引（页面文件未改动）`);
    writeSpaces(DATA_DIR, recovered.spaces);
    return;
  }

  // `onlyCreate` for the same reason as migration: seeding establishes the store, so it must
  // never overwrite a page file that is already there.
  writeDb(seedDb(), [], { onlyCreate: true });
  console.log(`· 已从示例数据初始化 → ${path.join(DATA_DIR, 'pages')}`);
}

/**
 * Move a migrated-away `pages.json` aside so it can never shadow the store again, keeping its
 * bytes as `pages.json.bak` for recovery. When a backup already exists the legacy file is only
 * removed if it is byte-identical — the crash-between-migration-and-this-step case. A differing
 * file is not a duplicate (it can be a snapshot copied in from another machine), so its bytes are
 * kept under a free `.bak.N` name rather than discarded.
 */
function retireLegacyFile(): void {
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;
  const backup = LEGACY_DATA_FILE + '.bak';
  try {
    if (!fs.existsSync(backup)) {
      fs.renameSync(LEGACY_DATA_FILE, backup);
      console.log(`· 已备份迁移前数据 → ${backup}`);
      return;
    }
    if (sameBytes(LEGACY_DATA_FILE, backup)) {
      fs.unlinkSync(LEGACY_DATA_FILE);
      return;
    }
    const kept = freeBackupName(backup);
    fs.renameSync(LEGACY_DATA_FILE, kept);
    console.warn(`· 发现另一份 ${path.basename(LEGACY_DATA_FILE)}（与已有备份不同），已保留为 ${path.basename(kept)}`);
  } catch {
    // Best effort: the file is only harmful if the index is later lost *and* it still predates the
    // page files, so a failed move is left for the next boot to retry rather than risking further
    // filesystem work. `ensureData` above also refuses to migrate a file that has a backup.
  }
}

/** Byte comparison of two files, false on any read error. */
function sameBytes(a: string, b: string): boolean {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** First unused `<backup>.N` path, so preserving a file never clobbers an existing one. */
function freeBackupName(backup: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${backup}.${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Convert a pre-store `data/pages.json` into the file layout, then retire the original to
 * `pages.json.bak`. The move is the point: leaving the original in place is what let a later
 * lost index re-import stale content over the user's edits.
 */
function migrateLegacyFile(): void {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8')); } catch { /* fallthrough */ }
  if (!raw || (raw.version !== 3 && raw.version !== 4)) {
    // An unreadable legacy file is not proof the site is empty: pages already in `pages/` are the
    // user's data and seeding over them would replace every one sharing a sample's name.
    const salvage = recoverStore(DATA_DIR);
    retireLegacyFile();
    if (salvage) {
      console.warn('· 旧数据格式无法识别，已按现有页面恢复（页面文件未改动）');
      writeSpaces(DATA_DIR, salvage.spaces);
      return;
    }
    console.warn('· 旧数据格式无法识别，已重置为初始示例数据');
    writeDb(seedDb(), [], { onlyCreate: true });
    return;
  }

  // Pages on disk outrank the snapshot's index: a space the user created after the snapshot was
  // taken is named by its pages' front matter but not by `spaces`, and writing that list verbatim
  // would drop the space and send its pages to the fallback on the next read.
  const live = recoverStore(DATA_DIR);
  const spaces: Space[] = mergeSpaces(raw.spaces || [], live?.spaces ?? []);
  const fromHtml = raw.version === 3;
  const pages: Page[] = (raw.pages || []).map((p: Page) => ({
    ...p,
    content: fromHtml ? htmlToMarkdown(p.content) : String(p.content ?? ''),
  }));
  // `onlyCreate`: an existing `<slug>.md` is live data and outranks this snapshot. That is what
  // makes a re-migration harmless — e.g. the legacy file survived its retirement (a crash between
  // the store write and the move) and the index was later lost, so this path runs again. Without
  // it, the stale snapshot would overwrite the user's edits; with it, only missing pages are added.
  writeDb({ version: 4, spaces, pages }, [], { onlyCreate: true });
  // Only after the store is safely written: the rename both preserves the original and stops it
  // from being treated as live data on any later boot.
  retireLegacyFile();
  console.log(
    fromHtml
      ? '· 数据已从 v3（HTML）迁移为 Markdown 文件'
      : '· 数据已从 pages.json 迁移为 Markdown 文件',
  );
}

function readDb(): Database {
  if (!storeExists(DATA_DIR)) ensureData();
  return readStore(DATA_DIR);
}
/** Persist `db`. `removed` must list the slugs this request deleted or renamed away; the store
 *  unlinks only those files, never every file the new db fails to mention (see writeStore). */
function writeDb(db: Database, removed: Iterable<string> = [], options: WriteOptions = {}): void {
  writeStore(DATA_DIR, db, removed, options);
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

/* ---------------------------------------------------- Content sanitizing (XSS) */

/* Markdown itself needs no tag scrubbing: `marked` output is sanitised in the browser with
   DOMPurify before it is inserted into the DOM, and raw HTML in the source is subject to the
   same pass. A regex scrubber here would instead corrupt code blocks that legitimately show
   HTML examples. The server only bounds the length (see sanitizeMarkdown in src/markdown.ts). */

function randomToken(len = 7): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < len; i++) t += abc[Math.floor(Math.random() * abc.length)];
  return t;
}
const SLUG_RE = /^[a-z0-9_]{1,80}$/;
const RESERVED_SLUGS = new Set(['spaces']); // Reserved keyword aliases that pages must not take over.

function slugify(title: unknown): string {
  // Yuque-style slugs: lowercase letters, digits and underscores; non-English titles fall back to a random token
  const s = String(title || '').trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return s || randomToken();
}

/* ------------------------------------------------------------ HTTP helpers */

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

/**
 * The page shell with the filing footer injected, read once at startup. The footer
 * must be present in the raw response, since compliance checks inspect the HTML
 * without executing scripts; doing the substitution per request would also re-read
 * the file for every SPA deep link.
 */
let indexHtmlCache: string | null = null;

function indexHtml(): string {
  if (indexHtmlCache !== null) return indexHtmlCache;
  let html = '';
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  } catch {
    return ''; // let the caller fall back to streaming the file
  }
  // injectFooter also consumes the marker when no filing is configured, so the
  // served HTML never ships an HTML comment describing an internal hook.
  indexHtmlCache = injectFooter(html, readFooterOptions(CONFIG));
  return indexHtmlCache;
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback so deep links resolve to the shell
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };

  // Every route resolves to the same shell, so serve the injected copy for it.
  if (file === path.join(PUBLIC_DIR, 'index.html')) {
    const html = indexHtml();
    if (html) {
      res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }
  }

  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/* --------------------------------------------------------------- Auth */

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const KDF_ITERS = 100000;              // PBKDF2-SHA256 iteration count
const SESSION_TTL = 7 * 86400e3;       // sessions slide-renew for 7 days
const sessions = new Map<string, Session>(); // token -> { user, exp }
const nonces = new Map<string, number>();    // login challenges (one-shot, 60s)
const failLog = new Map<string, { n: number; ts: number }>(); // failed-login rate limit (per IP)

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
  s.exp = Date.now() + SESSION_TTL; // slide the expiry forward
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
      user: sess ? sess.user : (a.user || null), // prefill the login form (the challenge endpoint exposes this name anyway)
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
    nonces.delete(nonce); // one-shot to block replay
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

/* --------------------------------------------------------------- Routing */

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const parts = pathname.split('/').filter(Boolean); // ['api','pages',':slug?']
  const key = parts[1] || '';

  /* Auth endpoints */
  if (key === 'auth') return handleAuth(req, res, parts);

  /* Document writes require a session (reads stay public) */
  if ((key === 'pages' || key === 'spaces') && req.method !== 'GET') {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: '请先登录后再修改', needAuth: true });
  }

  const db = readDb();

  /* Full tree: spaces + page metadata */
  if (req.method === 'GET' && key === 'tree' && parts.length === 2) {
    return json(res, 200, {
      spaces: db.spaces,
      pages: db.pages.map(({ content, ...meta }) => meta),
    });
  }

  /* ---- Spaces ---- */
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
        // Validate all fields before applying anything: an early return must not leave a
        // partially updated tree behind (a slug rename also re-points every page, so it
        // has to be committed together with the rest).
        let nextSlug: string | null = null;
        if (body.slug !== undefined) {
          const ns = String(body.slug || '').trim();
          if (!SLUG_RE.test(ns)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
          if (RESERVED_SLUGS.has(ns)) return json(res, 400, { error: '该 slug 为系统保留字' });
          if (ns !== slug && (db.pages.some(p => p.slug === ns) || db.spaces.some(s => s.slug === ns))) {
            return json(res, 400, { error: '该 slug 已被占用' });
          }
          if (ns !== slug) nextSlug = ns;
        }
        let nextTitle: string | null = null;
        if (body.title !== undefined) {
          const t = String(body.title).trim().slice(0, 120);
          if (!t) return json(res, 400, { error: '空间名称不能为空' });
          nextTitle = t;
        }

        if (nextSlug !== null) {
          const ns = nextSlug;
          db.pages.forEach(p => { if (p.space === slug) p.space = ns; });
          db.spaces[idx].slug = ns;
        }
        if (nextTitle !== null) db.spaces[idx].title = nextTitle;
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
        writeDb(db, removedPages);
        return json(res, 200, { ok: true, removedSpace: spaceSlug, removedPages });
      }
    }
  }

  /* ---- Pages ---- */
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
      let renamed = false;
      if (body.slug !== undefined) {
        const ns = String(body.slug || '').trim();
        if (!SLUG_RE.test(ns)) return json(res, 400, { error: 'slug 只能含小写字母、数字、下划线（1–80 位）' });
        if (RESERVED_SLUGS.has(ns)) return json(res, 400, { error: '该 slug 为系统保留字' });
        if (ns !== slug && (db.pages.some(p => p.slug === ns) || db.spaces.some(s => s.slug === ns))) {
          return json(res, 400, { error: '该 slug 已被占用' });
        }
        if (ns !== slug) {
          renamed = true;
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
      if (body.content !== undefined) db.pages[idx].content = sanitizeMarkdown(body.content);
      db.pages[idx].updatedAt = Date.now();
      // A slug rename leaves the old file behind, so it is declared for removal here; the store
      // keeps it if the new slug happens to reuse the same name.
      writeDb(db, renamed ? [slug] : []);
      return json(res, 200, db.pages[idx]);
    }
    if (req.method === 'DELETE') {
      if (idx < 0) return json(res, 404, { error: '页面不存在' });
      const doomed = [slug, ...descendantsOf(db.pages, slug)];
      db.pages = db.pages.filter(p => !doomed.includes(p.slug));
      // Any space whose home was among the removed pages (the page itself or a descendant)
      // would otherwise keep a pointer to a slug that no longer resolves.
      for (const sp of db.spaces) if (sp.home && doomed.includes(sp.home)) sp.home = null;
      writeDb(db, doomed);
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

/* ------------------------------------------------- Free-port startup scan */

function listen(server: Server, port: number, retriesLeft: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE' && retriesLeft > 0) resolve(listen(server, port + 1, retriesLeft - 1, host));
      else reject(err);
    });
    server.listen(port, host, () => resolve(port));
  });
}

async function main(): Promise<void> {
  ensureData();
  const startPort = CONFIG.port;
  const host = CONFIG.host; // undefined = all interfaces
  // Port scanning suits interactive local use, but a service manager must fail
  // loudly instead of silently drifting to another port (the reverse proxy points
  // at one specific port). strictPort disables the scan.
  const retries = CONFIG.strictPort ? 0 : 50;
  const server = http.createServer(handler);
  try {
    const port = await listen(server, startPort, retries, host);
    // The package may live in a read-only store, so a failure here is expected
    // and harmless: the PID file is only a local-development convenience.
    try { fs.writeFileSync(path.join(ROOT, '.server.pid'), String(process.pid)); } catch { /* ignore */ }
    console.log(`\n  ✦ DocLight 文档站已就绪 (PID ${process.pid})`);
    console.log(`    本机访问  http://localhost:${port}`);
    console.log(`    数据目录  ${DATA_DIR}\n`);
  } catch (err) {
    console.error('启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
main();
